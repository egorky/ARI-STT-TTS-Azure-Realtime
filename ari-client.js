'use strict';

const AriClient = require('ari-client');
const { v4: uuidv4 } = require('uuid');
const RtpServer = require('./rtp-server');
const AzureService = require('./azure-service');
const { ulawToPcm } = require('./audio-converter');
const soundManager = require('./sound-manager');
const config = require('./config');

class App {
    constructor() {
        this.ariClient = null;
        this.azureService = new AzureService(config);
        this.activeCalls = new Map(); // Track active calls by channel ID
    }

    async start() {
        try {
            await soundManager.initialize();
            this.ariClient = await AriClient.connect(config.ari.url, config.ari.username, config.ari.password);
            console.log('Connected to Asterisk ARI');

            this.ariClient.on('StasisStart', (event, channel) => {
                // Ignore channels that are part of an existing call setup (snoop/external)
                if (this.isInternalChannel(channel.id)) {
                    console.log(`Ignoring internal channel ${channel.id} entering Stasis.`);
                    // Simply answer and do nothing else.
                    channel.answer().catch(err => console.error(`Failed to answer internal channel ${channel.id}:`, err));
                    return;
                }
                this.handleCall(channel);
            });

            this.ariClient.on('StasisEnd', (event, channel) => {
                if (this.activeCalls.has(channel.id)) {
                    console.log(`Main channel ${channel.id} left Stasis. Cleaning up associated resources.`);
                    this.cleanup(this.activeCalls.get(channel.id));
                    this.activeCalls.delete(channel.id);
                }
            });

            this.ariClient.start(config.ari.appName);
            console.log(`ARI application '${config.ari.appName}' started.`);

        } catch (err) {
            console.error('Failed to connect or start ARI client:', err);
            process.exit(1);
        }
    }

    isInternalChannel(channelId) {
        for (const callState of this.activeCalls.values()) {
            if ((callState.snoopChannel && callState.snoopChannel.id === channelId) ||
                (callState.externalMediaChannel && callState.externalMediaChannel.id === channelId)) {
                return true;
            }
        }
        return false;
    }

    async handleCall(channel) {
        console.log(`Incoming call on channel ${channel.id}`);
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
        };

        this.activeCalls.set(channel.id, callState);

        try {
            await channel.answer();
            console.log(`Channel ${channel.id} answered.`);

            const textToSpeak = await channel.getChannelVar({ variable: 'TEXT_TO_SPEAK' });
            if (!textToSpeak || !textToSpeak.value) {
                throw new Error('TEXT_TO_SPEAK variable not set on the channel.');
            }

            // 1. Setup Azure STT
            this.setupStt(callState);

            // 2. Setup audio snooping
            await this.setupAudioSnooping(callState);

            // 3. Synthesize and play audio
            await this.playTtsAudio(callState, textToSpeak.value);

            // 4. Enable talk detection after a delay
            setTimeout(() => {
                this.enableTalkDetection(callState);
            }, config.app.talkDetectActivationDelay);

        } catch (err) {
            console.error(`Error handling call on channel ${channel.id}:`, err);
            // The StasisEnd handler will trigger cleanup for this call
        }
    }

    setupStt(callState) {
        this.azureService.startContinuousRecognition();
        this.azureService.once('audioStreamReady', (pushStream) => {
            callState.sttPushStream = pushStream;
        });
        this.azureService.once('recognitionEnded', (result) => {
            callState.finalTranscript = result.finalText;
            console.log(`Final transcript for ${callState.mainChannel.id}: ${result.finalText}`);
            this.continueInDialplan(callState);
        });
        this.azureService.on('recognitionError', (err) => {
            console.error(`STT Error for ${callState.mainChannel.id}:`, err);
            this.continueInDialplan(callState); // Continue even on error
        });
    }

    async setupAudioSnooping(callState) {
        const { mainChannel } = callState;

        // Create user bridge and add channel
        callState.userBridge = this.ariClient.Bridge();
        await callState.userBridge.create({ type: 'mixing' });
        await callState.userBridge.addChannel({ channel: mainChannel.id });
        console.log(`User bridge ${callState.userBridge.id} created for channel ${mainChannel.id}`);

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
        console.log(`Snoop channel ${callState.snoopChannel.id} created for channel ${mainChannel.id}`);

        // Create external media channel
        callState.externalMediaChannel = await this.ariClient.channels.externalMedia({
            app: config.ari.appName,
            external_host: `${rtpServerAddress.address}:${rtpServerAddress.port}`,
            format: config.rtpServer.audioFormat,
        });
        console.log(`External media channel ${callState.externalMediaChannel.id} created.`);

        // Create snoop bridge and bridge channels
        callState.snoopBridge = this.ariClient.Bridge();
        await callState.snoopBridge.create({ type: 'mixing' });
        await callState.snoopBridge.addChannel({ channel: [callState.snoopChannel.id, callState.externalMediaChannel.id] });
        console.log(`Snoop bridge ${callState.snoopBridge.id} created.`);
    }

    async playTtsAudio(callState, text) {
        const { mainChannel, userBridge } = callState;
        let tempAudioFile = null;

        try {
            const ttsAudioStream = await this.azureService.synthesizeText(text);

            const audioBuffer = await new Promise((resolve, reject) => {
                const chunks = [];
                ttsAudioStream.on('data', chunk => chunks.push(chunk));
                ttsAudioStream.on('end', () => resolve(Buffer.concat(chunks)));
                ttsAudioStream.on('error', reject);
            });

            tempAudioFile = await soundManager.saveTempAudio(audioBuffer);

            console.log(`Playing temporary audio file ${tempAudioFile.filePath} to channel ${mainChannel.id}`);

            callState.playback = this.ariClient.Playback();
            const playbackFinished = new Promise(resolve => {
                callState.playback.once('PlaybackFinished', resolve);
                callState.playback.once('PlaybackFailed', resolve); // Also resolve on failure to ensure cleanup
            });

            await userBridge.play({ media: tempAudioFile.soundUri, playbackId: callState.playback.id });

            console.log(`Playback started on channel ${mainChannel.id}`);
            await playbackFinished;
            console.log(`Playback finished on channel ${mainChannel.id}`);

        } finally {
            if (tempAudioFile) {
                await soundManager.cleanupTempAudio(tempAudioFile.filePath);
            }
        }
    }

    enableTalkDetection(callState) {
        const { mainChannel } = callState;
        console.log(`Enabling talk detection on channel ${mainChannel.id}`);

        mainChannel.on('ChannelTalkingStarted', () => {
            console.log(`Talking started on ${mainChannel.id}. Starting recognition.`);
            callState.isRecognizing = true;
        });

        mainChannel.on('ChannelTalkingFinished', (event) => {
            console.log(`Talking finished on ${mainChannel.id}. Duration: ${event.duration} ms. Stopping recognition.`);
            callState.isRecognizing = false;
            // The session will stop automatically after a short timeout.
            // We can also force it if needed, but letting Azure detect the end of speech is often better.
        });

        // The format for TALK_DETECT is a string of key=value pairs.
        // Example: "speech_threshold=500,silence_threshold=1200"
        const talkDetectValue = `speech_threshold=${config.app.talkDetect.speechThreshold},silence_threshold=${config.app.talkDetect.silenceThreshold}`;

        mainChannel.setChannelVar({
            variable: 'TALK_DETECT(set)',
            value: talkDetectValue
        }).catch(err => {
            console.error(`Failed to set TALK_DETECT on channel ${mainChannel.id}:`, err);
        });
    }

    async continueInDialplan(callState) {
        if (callState && callState.mainChannel) {
            console.log(`Continuing in dialplan for channel ${callState.mainChannel.id}`);
            try {
                await callState.mainChannel.setChannelVar({ variable: 'TRANSCRIPT', value: callState.finalTranscript });
                await callState.mainChannel.continueInDialplan();
            } catch (err) {
                 console.error(`Error continuing in dialplan for ${callState.mainChannel.id}:`, err);
            }
        }
        // Cleanup will be handled by StasisEnd
    }

    async cleanup(callState) {
        if (!callState) return;
        console.log(`Cleaning up resources for main channel ${callState.mainChannel.id}...`);

        // Remove listeners
        callState.mainChannel.removeAllListeners('ChannelTalkingStarted');
        callState.mainChannel.removeAllListeners('ChannelTalkingFinished');

        if (callState.snoopChannel) {
            try { await callState.snoopChannel.hangup(); } catch (e) { /* ignore */ }
        }
        if (callState.externalMediaChannel) {
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
