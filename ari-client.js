'use strict';

const AriClient = require('ari-client');
const { v4: uuidv4 } = require('uuid');
const RtpServer = require('./rtp-server');
const AzureService = require('./azure-service');
const { ulawToPcm } = require('./audio-converter');
const soundManager = require('./sound-manager');
const config = require('./config');
const logger = require('./logger');

class App {
    constructor() {
        this.ariClient = null;
        this.azureService = new AzureService(config);
        this.activeCalls = new Map(); // Track active calls by channel ID
        this.internalChannelIds = new Set(); // Track all channels created by the app
    }

    async start() {
        try {
            await soundManager.initialize();
            this.ariClient = await AriClient.connect(config.ari.url, config.ari.username, config.ari.password);
            logger.info('Connected to Asterisk ARI');

            this.ariClient.on('StasisStart', (event, channel) => {
                // Ignore channels that are part of an existing call setup (snoop/external)
                if (this.isInternalChannel(channel.id)) {
                    logger.info(`Ignoring internal channel ${channel.id} entering Stasis.`);
                    // Simply answer and do nothing else.
                    channel.answer().catch(err => logger.error(`Failed to answer internal channel ${channel.id}:`, err));
                    return;
                }
                this.handleCall(channel);
            });

            this.ariClient.on('StasisEnd', (event, channel) => {
                if (this.activeCalls.has(channel.id)) {
                    logger.info(`Main channel ${channel.id} left Stasis. Cleaning up associated resources.`);
                    this.cleanup(this.activeCalls.get(channel.id));
                    this.activeCalls.delete(channel.id);
                }
            });

            this.ariClient.start(config.ari.appName);
            logger.info(`ARI application '${config.ari.appName}' started.`);

        } catch (err) {
            logger.error('Failed to connect or start ARI client:', err);
            process.exit(1);
        }
    }

    isInternalChannel(channelId) {
        return this.internalChannelIds.has(channelId);
    }

    async handleCall(channel) {
        logger.info(`Incoming call on channel ${channel.id}`);
        const callState = {
            mainChannel: channel,
            userBridge: null,
            snoopChannel: null,
            snoopBridge: null,
            externalMediaChannel: null,
            rtpServer: null,
            sttPushStream: null,
            isRecognizing: false,
            finalTranscript: '',
            playback: null,
            recognitionPromise: null, // To await the final transcript
        };

        this.activeCalls.set(channel.id, callState);

        try {
            await channel.answer();
            logger.info(`Channel ${channel.id} answered.`);

            const textToSpeak = await channel.getChannelVar({ variable: 'TEXT_TO_SPEAK' });
            if (!textToSpeak || !textToSpeak.value) {
                throw new Error('TEXT_TO_SPEAK variable not set on the channel.');
            }

            // 1. Setup STT and the promise to wait for its completion
            this.setupStt(callState);

            // 2. Setup audio snooping
            await this.setupAudioSnooping(callState);

            // 3. Play audio and enable talk detection
            await this.playTtsAudio(callState, textToSpeak.value);
            this.enableTalkDetection(callState); // Enable immediately after playback

            // 4. Wait for the recognition to complete
            logger.info(`Channel ${channel.id} is now waiting for speech recognition to complete.`);
            await callState.recognitionPromise;

            // 5. Continue in dialplan
            await this.continueInDialplan(callState);

        } catch (err) {
            logger.error(`Error handling call on channel ${channel.id}:`, err);
            // The StasisEnd handler will trigger cleanup for this call
        }
    }

    setupStt(callState) {
        let recognitionResolve;
        callState.recognitionPromise = new Promise(resolve => {
            recognitionResolve = resolve;
        });

        this.azureService.startContinuousRecognition();

        this.azureService.once('audioStreamReady', (pushStream) => {
            callState.sttPushStream = pushStream;
        });

        this.azureService.once('recognitionEnded', (result) => {
            callState.finalTranscript = result.finalText;
            logger.info(`Final transcript for ${callState.mainChannel.id}: ${result.finalText}`);
            recognitionResolve();
        });

        this.azureService.on('recognitionError', (err) => {
            logger.error(`STT Error for ${callState.mainChannel.id}:`, err);
            recognitionResolve(); // Resolve even on error to unblock the call flow
        });
    }

    async setupAudioSnooping(callState) {
        const { mainChannel } = callState;

        // Create user bridge and add channel
        callState.userBridge = this.ariClient.Bridge();
        await callState.userBridge.create({ type: 'mixing' });
        await callState.userBridge.addChannel({ channel: mainChannel.id });
        logger.info(`User bridge ${callState.userBridge.id} created for channel ${mainChannel.id}`);

        // Start RTP server
        callState.rtpServer = new RtpServer();
        const rtpServerAddress = await callState.rtpServer.listen(config.rtpServer.ip, config.rtpServer.port);

        callState.rtpServer.on('audioPacket', (audio) => {
            if (callState.isRecognizing && callState.sttPushStream) {
                const pcmAudio = ulawToPcm(audio);
                callState.sttPushStream.write(pcmAudio);
            }
        });

        // Create snoop channel
        const snoopId = uuidv4();
        callState.snoopChannel = await this.ariClient.channels.snoopChannelWithId({
            channelId: mainChannel.id,
            snoopId: snoopId,
            app: config.ari.appName,
            spy: 'in'
        });
        this.internalChannelIds.add(callState.snoopChannel.id);
        logger.info(`Snoop channel ${callState.snoopChannel.id} created for channel ${mainChannel.id}`);

        // Create external media channel
        callState.externalMediaChannel = await this.ariClient.channels.externalMedia({
            app: config.ari.appName,
            external_host: `${rtpServerAddress.address}:${rtpServerAddress.port}`,
            format: config.rtpServer.audioFormat,
        });
        this.internalChannelIds.add(callState.externalMediaChannel.id);
        logger.info(`External media channel ${callState.externalMediaChannel.id} created.`);

        // Create snoop bridge and bridge channels
        callState.snoopBridge = this.ariClient.Bridge();
        await callState.snoopBridge.create({ type: 'mixing' });
        await callState.snoopBridge.addChannel({ channel: [callState.snoopChannel.id, callState.externalMediaChannel.id] });
        logger.info(`Snoop bridge ${callState.snoopBridge.id} created.`);
    }

    async playTtsAudio(callState, text) {
        const { mainChannel, userBridge } = callState;

        try {
            const ttsAudioStream = await this.azureService.synthesizeText(text);

            let resolveStreamEnd;
            const streamEndPromise = new Promise(resolve => {
                resolveStreamEnd = resolve;
            });

            const chunkQueue = [];
            const allChunks = [];
            let streamFinished = false;
            let processing = false;

            const processQueue = async () => {
                if (processing || chunkQueue.length === 0) {
                    if (streamFinished && chunkQueue.length === 0) {
                        resolveStreamEnd();
                    }
                    return;
                }
                processing = true;

                const chunk = chunkQueue.shift();

                try {
                    const tempAudioFile = await soundManager.saveTempAudio(chunk);
                    logger.info(`Queueing chunk ${tempAudioFile.filePath} for playback.`);

                    const playback = this.ariClient.Playback();
                    playback.once('PlaybackFinished', () => {
                        logger.info(`Finished playing chunk ${tempAudioFile.filePath}.`);
                        soundManager.cleanupTempAudio(tempAudioFile.filePath); // Fire-and-forget
                        processQueue(); // Process next chunk
                    });

                    await userBridge.play({ media: tempAudioFile.soundUri, playbackId: playback.id });
                } catch (err) {
                    logger.error('Error processing TTS audio chunk:', err);
                } finally {
                    processing = false;
                    if (chunkQueue.length > 0) {
                        processQueue();
                    } else if (streamFinished) {
                        resolveStreamEnd();
                    }
                }
            };

            ttsAudioStream.on('data', (chunk) => {
                if (chunk.length > 0) {
                    chunkQueue.push(chunk);
                    allChunks.push(chunk);
                    processQueue();
                }
            });

            ttsAudioStream.on('end', () => {
                logger.info('TTS stream from Azure has ended.');
                streamFinished = true;
                if (!processing && chunkQueue.length === 0) {
                    resolveStreamEnd();
                }
            });

            await streamEndPromise;
            logger.info(`All TTS chunks have been played for channel ${mainChannel.id}.`);

            // Save the full audio file
            const fullAudioBuffer = Buffer.concat(allChunks);
            await soundManager.saveFinalAudio(fullAudioBuffer, mainChannel.id);

        } catch (err) {
            logger.error(`Error during TTS streaming playback for channel ${mainChannel.id}:`, err);
        }
    }

    enableTalkDetection(callState) {
        const { mainChannel } = callState;
        logger.info(`Enabling talk detection on channel ${mainChannel.id}`);

        mainChannel.on('ChannelTalkingStarted', () => {
            logger.info(`Talking started on ${mainChannel.id}. Starting recognition.`);
            callState.isRecognizing = true;
        });

        mainChannel.on('ChannelTalkingFinished', (event) => {
            logger.info(`Talking finished on ${mainChannel.id}. Duration: ${event.duration} ms. Stopping recognition stream.`);
            callState.isRecognizing = false;

            // Explicitly signal to the Azure SDK that the audio stream is finished.
            // This will trigger a final 'recognized' event and then 'sessionStopped'.
            if (this.azureService) {
                this.azureService.stopContinuousRecognition();
            }
        });

        // Setting TALK_DETECT values. Some Asterisk versions expect a positional format.
        // Format: "<silence_threshold>,<speech_threshold>"
        const talkDetectValue = `${config.app.talkDetect.silenceThreshold},${config.app.talkDetect.speechThreshold}`;

        mainChannel.setChannelVar({
            variable: 'TALK_DETECT(set)',
            value: talkDetectValue
        }).catch(err => {
            logger.error(`Failed to set TALK_DETECT on channel ${mainChannel.id}:`, err);
        });
    }

    async continueInDialplan(callState) {
        if (callState && callState.mainChannel) {
            logger.info(`Continuing in dialplan for channel ${callState.mainChannel.id}`);
            try {
                await callState.mainChannel.setChannelVar({ variable: 'TRANSCRIPT', value: callState.finalTranscript });
                await callState.mainChannel.continueInDialplan();
            } catch (err) {
                 logger.error(`Error continuing in dialplan for ${callState.mainChannel.id}:`, err);
            }
        }
        // Cleanup will be handled by StasisEnd
    }

    async cleanup(callState) {
        if (!callState) return;
        logger.info(`Cleaning up resources for main channel ${callState.mainChannel.id}...`);

        // Remove listeners
        callState.mainChannel.removeAllListeners('ChannelTalkingStarted');
        callState.mainChannel.removeAllListeners('ChannelTalkingFinished');

        if (callState.snoopChannel) {
            this.internalChannelIds.delete(callState.snoopChannel.id);
            try { await callState.snoopChannel.hangup(); } catch (e) { /* ignore */ }
        }
        if (callState.externalMediaChannel) {
            this.internalChannelIds.delete(callState.externalMediaChannel.id);
            try { await callState.externalMediaChannel.hangup(); } catch (e) { /* ignore */ }
        }
        if (callState.userBridge) {
            try { await callState.userBridge.destroy(); } catch (e) { /* ignore */ }
        }
        if (callState.snoopBridge) {
            try { await callState.snoopBridge.destroy(); } catch (e) { /* ignore */ }
        }
        if (callState.rtpServer) {
            callState.rtpServer.close();
        }
        if (this.azureService) {
            this.azureService.stopContinuousRecognition();
        }
    }
}

module.exports = App;
