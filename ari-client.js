'use strict';

const AriClient = require('ari-client');
const { v4: uuidv4 } = require('uuid');
const RtpServer = require('./rtp-server');
const AzureService = require('./azure-service');
const { ulawToPcm } = require('./audio-converter');
const soundManager = require('./sound-manager');
const config = require('./config');
const createLogger = require('./logger');
const db = require('./database');

const logger = createLogger(); // Global logger for app-level events

class App {
    constructor() {
        this.ariClient = null;
        // this.azureService is no longer global
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
                    // Use a temporary logger as we don't have full context yet
                    createLogger().info(`Ignoring internal channel ${channel.id} entering Stasis.`);
                    channel.answer().catch(err => createLogger().error(`Failed to answer internal channel ${channel.id}:`, err));
                    return;
                }
                this.handleCall(channel);
            });

            this.ariClient.on('StasisEnd', (event, channel) => {
                const callState = this.activeCalls.get(channel.id);
                if (callState) {
                    callState.logger.info(`Main channel ${channel.id} left Stasis. Cleaning up associated resources.`);
                    this.cleanup(callState);
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
        const callerId = channel.caller.number;
        const uniqueId = channel.id; // Use the full, unique channel ID
        const logger = createLogger({ uniqueId, callerId });

        logger.info(`Incoming call`);
        const callState = {
            logger,
            mainChannel: channel,
            azureService: new AzureService(config, logger),
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
            isPlayingPrompt: false,
            timers: {
                session: null,
                noInput: null,
                dtmf: null,
            },
            dtmfDigits: '',
            recognitionMode: 'voice', // Can be 'voice' or 'dtmf'
            sttAudioChunks: [],
            sttAudioPath: null,
        };

        this.activeCalls.set(channel.id, callState);

        try {
            // Start session timeout
            if (config.app.timeouts.session > 0) {
                callState.timers.session = setTimeout(() => {
                    logger.warn(`Session timeout reached for channel ${channel.id}. Hanging up.`);
                    channel.hangup().catch(e => logger.error(`Error hanging up channel on session timeout:`, e));
                }, config.app.timeouts.session);
            }

            await channel.answer();
            logger.info(`Channel ${channel.id} answered.`);

            const textToSpeakVar = await channel.getChannelVar({ variable: 'TEXT_TO_SPEAK' });
            if (!textToSpeakVar || !textToSpeakVar.value) {
                throw new Error('TEXT_TO_SPEAK variable not set on the channel.');
            }
            const textToSpeak = textToSpeakVar.value;
            callState.textToSynthesize = textToSpeak;

            // 1. Setup audio snooping
            await this.setupAudioSnooping(callState);

            // 3. Play audio in the background. Don't await it.
            this.playTtsAudio(callState, textToSpeak);

            // 4. The call will now wait until the user hangs up or recognition completes.
            // The logic continues in the StasisEnd handler or after recognitionPromise resolves.
            logger.info(`Channel is now in a listening state.`);

        } catch (err) {
            logger.error(`Error handling call:`, err);
            // The StasisEnd handler will trigger cleanup for this call
        }
    }

    setupStt(callState) {
        const { azureService, logger } = callState;
        let recognitionResolve;
        callState.recognitionPromise = new Promise(resolve => {
            recognitionResolve = resolve;
        });

        const streamReadyPromise = new Promise(resolve => {
            azureService.once('audioStreamReady', (pushStream) => {
                callState.sttPushStream = pushStream;
                resolve(pushStream);
            });
        });

        azureService.startContinuousRecognition();

        azureService.once('recognitionEnded', (result) => {
            callState.finalTranscript = result.finalText;
            logger.info(`Final transcript: ${result.finalText}`);
            recognitionResolve();
        });

        azureService.on('recognitionError', (err) => {
            logger.error(`STT Error:`, err);
            recognitionResolve(); // Resolve even on error to unblock the call flow
        });

        return streamReadyPromise;
    }

    async setupAudioSnooping(callState) {
        const { mainChannel } = callState;

        // Create user bridge and add channel
        callState.userBridge = this.ariClient.Bridge();
        await callState.userBridge.create({ type: 'mixing' });
        await callState.userBridge.addChannel({ channel: mainChannel.id });
        callState.logger.info(`User bridge ${callState.userBridge.id} created.`);

        // Start RTP server
        callState.rtpServer = new RtpServer(callState.logger);
        const rtpServerAddress = await callState.rtpServer.listen(config.rtpServer.ip, config.rtpServer.port);

        callState.rtpServer.on('audioPacket', (audio) => {
            if (callState.isRecognizing && callState.sttPushStream) {
                // Keep the raw u-law audio for saving later
                callState.sttAudioChunks.push(audio);
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
        callState.logger.info(`Snoop channel ${callState.snoopChannel.id} created.`);

        // Create external media channel
        callState.externalMediaChannel = await this.ariClient.channels.externalMedia({
            app: config.ari.appName,
            external_host: `${rtpServerAddress.address}:${rtpServerAddress.port}`,
            format: config.rtpServer.audioFormat,
        });
        this.internalChannelIds.add(callState.externalMediaChannel.id);
        callState.logger.info(`External media channel ${callState.externalMediaChannel.id} created.`);

        // Create snoop bridge and bridge channels
        callState.snoopBridge = this.ariClient.Bridge();
        await callState.snoopBridge.create({ type: 'mixing' });
        await callState.snoopBridge.addChannel({ channel: [callState.snoopChannel.id, callState.externalMediaChannel.id] });
        callState.logger.info(`Snoop bridge ${callState.snoopBridge.id} created.`);
    }

    async playTtsAudio(callState, text) {
        const { mainChannel, userBridge, logger, azureService } = callState;
        callState.isPlayingPrompt = true;

        try {
            const ttsAudioStream = await azureService.synthesizeText(text);

            let resolveStreamEnd;
            const streamEndPromise = new Promise(resolve => {
                resolveStreamEnd = resolve;
            });

            const chunkQueue = [];
            const allChunks = [];
            let streamFinished = false;
            let processing = false;
            let vadEnabled = false;

            const processQueue = async () => {
                if (processing || chunkQueue.length === 0 || !callState.isPlayingPrompt) {
                    if (streamFinished && chunkQueue.length === 0) {
                        resolveStreamEnd();
                    }
                    return;
                }
                processing = true;

                if (!vadEnabled && config.app.vad.activationMode === 'after_prompt_start') {
                    vadEnabled = true;
                    setTimeout(() => this.enableTalkDetection(callState), config.app.vad.activationDelay);
                }

                const chunk = chunkQueue.shift();

                try {
                    const tempAudioFile = await soundManager.saveTempAudio(chunk, callState.logger);
                    callState.logger.info(`Queueing chunk ${tempAudioFile.filePath} for playback.`);

                    const playback = this.ariClient.Playback();
                    playback.once('PlaybackFinished', () => {
                        callState.logger.info(`Finished playing chunk ${tempAudioFile.filePath}.`);
                        soundManager.cleanupTempAudio(tempAudioFile.filePath, callState.logger); // Fire-and-forget
                        processing = false;
                        processQueue(); // Process next chunk
                    });

                    await userBridge.play({ media: tempAudioFile.soundUri, playbackId: playback.id });
                } catch (err) {
                    callState.logger.error('Error processing TTS audio chunk:', err);
                    processing = false;
                }
            };

            ttsAudioStream.on('data', (chunk) => {
                if (chunk.length > 0) {
                    chunkQueue.push(chunk);
                    allChunks.push(chunk);
                    processQueue();
                }
            });

            ttsAudioStream.on('end', async () => {
                callState.logger.info('TTS stream from Azure has ended.');
                streamFinished = true;

                // Save the full audio file as soon as the stream ends
                const fullAudioBuffer = Buffer.concat(allChunks);
            const finalAudioPath = await soundManager.saveFinalAudio(
                fullAudioBuffer,
                'tts',
                { uniqueId: mainChannel.id, callerId: mainChannel.caller.number },
                logger
            );
                callState.synthesizedAudioPath = finalAudioPath;

                if (!processing && chunkQueue.length === 0) {
                    resolveStreamEnd();
                }
            });

            await streamEndPromise;
            logger.info(`All TTS chunks have been queued for playback.`);

            if (config.app.vad.activationMode === 'after_prompt_end') {
                this.enableTalkDetection(callState);
            }

        } catch (err) {
            logger.error(`Error during TTS streaming playback:`, err);
        } finally {
            callState.isPlayingPrompt = false;
            logger.info('Finished playing prompt.');
        }
    }

    enableTalkDetection(callState) {
        const { mainChannel, userBridge, rtpServer, logger } = callState;
        logger.info(`Enabling talk detection.`);

        // Start pre-buffering audio to catch the beginning of speech
        rtpServer.startPreBuffering(config.rtpServer.preBufferSize);

        // Start no-input timer
        if (config.app.timeouts.noInput > 0) {
            callState.timers.noInput = setTimeout(() => {
                logger.warn(`No-input timeout reached. Hanging up.`);
                mainChannel.hangup().catch(e => logger.error(`Error hanging up channel on no-input timeout:`, e));
            }, config.app.timeouts.noInput);
        }

        const onTalkingStarted = async () => {
            // Once user speaks, clear the no-input timer
            clearTimeout(callState.timers.noInput);

            // This event can fire multiple times, but we only want to start the STT session once.
            // We remove the listener immediately to prevent re-entry.
            mainChannel.removeListener('ChannelTalkingStarted', onTalkingStarted);

            if (callState.isPlayingPrompt) {
                logger.info('Barge-in detected. Stopping prompt playback.');
                callState.isPlayingPrompt = false; // Stop the prompt loop
                if (userBridge) {
                    try {
                        // Stop any currently playing audio on the bridge
                        await userBridge.stopMoh();
                    } catch (e) {
                         // ignore if no playback
                    }
                }
            }

            logger.info(`Talking started. Starting recognition session with Azure.`);

            // Stop pre-buffering and get the buffered audio
            const preBufferedAudio = rtpServer.stopPreBufferingAndFlush();
            if (preBufferedAudio.length > 0) {
                callState.sttAudioChunks.push(preBufferedAudio);
            }

            // Start the STT service and wait for the push stream to be ready
            const pushStream = await this.setupStt(callState);

            // Push the pre-buffered audio first
            if (preBufferedAudio.length > 0) {
                const pcmPreBufferedAudio = ulawToPcm(preBufferedAudio);
                pushStream.write(pcmPreBufferedAudio);
                logger.info(`Pushed ${preBufferedAudio.length} bytes of pre-buffered audio to Azure.`);
            }

            // Now, start sending real-time audio
            callState.isRecognizing = true;

            await callState.recognitionPromise;
            await this.continueInDialplan(callState);
        };

        const onTalkingFinished = (event) => {
             if (callState.isRecognizing) { // Only act if we were actively recognizing
                logger.info(`Talking finished. Duration: ${event.duration} ms. Stopping recognition stream.`);
                callState.isRecognizing = false;
                if (callState.azureService) {
                    callState.azureService.stopContinuousRecognition();
                }
            }
        };

        const onDtmfReceived = async (event) => {
            // This logic runs for the FIRST digit received.
            if (callState.recognitionMode === 'voice') {
                logger.info(`DTMF digit '${event.digit}' received. Switching to DTMF mode.`);
                callState.recognitionMode = 'dtmf';

                // Cancel voice-related timers and listeners
                clearTimeout(callState.timers.noInput);
                mainChannel.removeListener('ChannelTalkingStarted', onTalkingStarted);
                if (callState.isRecognizing) {
                    callState.azureService.stopContinuousRecognition();
                    callState.isRecognizing = false;
                }

                // Barge-in for DTMF
                if (callState.isPlayingPrompt) {
                    logger.info('DTMF Barge-in detected. Stopping prompt playback.');
                    callState.isPlayingPrompt = false;
                    if (userBridge) {
                        try { await userBridge.stopMoh(); } catch (e) { /* ignore */ }
                    }
                }
            }

            // This logic runs for EVERY digit received.
            callState.dtmfDigits += event.digit;
            logger.info(`Current DTMF digits: ${callState.dtmfDigits}`);

            // Reset the completion timer
            clearTimeout(callState.timers.dtmf);
            callState.timers.dtmf = setTimeout(async () => {
                logger.info(`DTMF completion timeout reached. Final digits: ${callState.dtmfDigits}`);
                await this.continueInDialplan(callState);
            }, config.app.dtmf.completionTimeout);
        };

        // Assign listeners
        mainChannel.on('ChannelTalkingStarted', onTalkingStarted);
        mainChannel.on('ChannelTalkingFinished', onTalkingFinished);
        if (config.app.dtmf.enabled) {
            mainChannel.on('ChannelDtmfReceived', onDtmfReceived);
        }

        // Setting TALK_DETECT values. Some Asterisk versions expect a positional format.
        // Format: "<silence_threshold>,<speech_threshold>"
        const talkDetectValue = `${config.app.talkDetect.silenceThreshold},${config.app.talkDetect.speechThreshold}`;

        mainChannel.setChannelVar({
            variable: 'TALK_DETECT(set)',
            value: talkDetectValue
        }).catch(err => {
            logger.error(`Failed to set TALK_DETECT:`, err);
        });
    }

    async saveInteraction(callState) {
        const { logger, mainChannel, textToSynthesize, synthesizedAudioPath, sttAudioPath, recognitionMode, finalTranscript, dtmfDigits } = callState;
        try {
            await db.Interaction.create({
                uniqueId: mainChannel.id,
                callerId: mainChannel.caller.number,
                textToSynthesize,
                synthesizedAudioPath,
                sttAudioPath,
                recognitionMode,
                transcript: finalTranscript,
                dtmfResult: dtmfDigits,
            });
            logger.info('Interaction saved to database.');
        } catch (dbError) {
            logger.error('Failed to save interaction to database:', dbError);
        }
    }

    async continueInDialplan(callState) {
        const { mainChannel, logger, sttAudioChunks } = callState;
        if (callState && mainChannel) {

            // Save the captured STT audio
            if (sttAudioChunks.length > 0) {
                const fullSttAudio = Buffer.concat(sttAudioChunks);
                const pcmSttAudio = ulawToPcm(fullSttAudio);
                const sttAudioPath = await soundManager.saveFinalAudio(
                    pcmSttAudio,
                    'stt',
                    { uniqueId: mainChannel.id, callerId: mainChannel.caller.number },
                    logger
                );
                callState.sttAudioPath = sttAudioPath;
            }

            // Save interaction to DB before continuing. This is fire-and-forget.
            this.saveInteraction(callState);

            logger.info(`Continuing in dialplan.`);
            try {
                if (callState.recognitionMode === 'dtmf') {
                    await mainChannel.setChannelVar({ variable: 'DTMF_RESULT', value: callState.dtmfDigits });
                    await mainChannel.setChannelVar({ variable: 'RECOGNITION_MODE', value: 'DTMF' });
                } else {
                    await mainChannel.setChannelVar({ variable: 'TRANSCRIPT', value: callState.finalTranscript });
                    await mainChannel.setChannelVar({ variable: 'RECOGNITION_MODE', value: 'VOICE' });
                }
                await mainChannel.continueInDialplan();
            } catch (err) {
                 logger.error(`Error continuing in dialplan:`, err);
            }
        }
        // Cleanup will be handled by StasisEnd
    }

    async cleanup(callState) {
        if (!callState) return;
        const { logger } = callState;
        logger.info(`Cleaning up resources...`);

        // Clear all timers
        clearTimeout(callState.timers.session);
        clearTimeout(callState.timers.noInput);
        clearTimeout(callState.timers.dtmf);

        // Remove all listeners from the channel to prevent memory leaks
        callState.mainChannel.removeAllListeners();

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
        if (callState.azureService) {
            callState.azureService.stopContinuousRecognition();
        }
    }
}

module.exports = App;
