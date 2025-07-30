'use strict';

const AriClient = require('ari-client');
const { v4: uuidv4 } = require('uuid');
const RtpServer = require('./rtp-server');
const AzureService = require('./azure-service');
const { ulawToPcm } = require('./audio-converter');
const config = require('./config');

class App {
    constructor() {
        this.ariClient = null;
        this.azureService = new AzureService(config);
    }

    async start() {
        try {
            this.ariClient = await AriClient.connect(config.ari.url, config.ari.username, config.ari.password);
            console.log('Connected to Asterisk ARI');

            this.ariClient.on('StasisStart', (event, channel) => {
                this.handleCall(channel);
            });

            this.ariClient.start(config.ari.appName);
            console.log(`ARI application '${config.ari.appName}' started.`);

        } catch (err) {
            console.error('Failed to connect or start ARI client:', err);
            process.exit(1);
        }
    }

    async handleCall(channel) {
        console.log(`Incoming call on channel ${channel.id}`);
        const callState = {
            channel,
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
            await this.cleanup(callState);
            await channel.hangup();
        }
    }

    setupStt(callState) {
        this.azureService.startContinuousRecognition();
        this.azureService.once('audioStreamReady', (pushStream) => {
            callState.sttPushStream = pushStream;
        });
        this.azureService.once('recognitionEnded', (result) => {
            callState.finalTranscript = result.finalText;
            console.log(`Final transcript for ${callState.channel.id}: ${result.finalText}`);
            this.continueInDialplan(callState);
        });
        this.azureService.on('recognitionError', (err) => {
            console.error(`STT Error for ${callState.channel.id}:`, err);
            this.continueInDialplan(callState); // Continue even on error
        });
    }

    async setupAudioSnooping(callState) {
        const { channel } = callState;

        // Create user bridge and add channel
        callState.userBridge = this.ariClient.Bridge();
        await callState.userBridge.create({ type: 'mixing' });
        await callState.userBridge.addChannel({ channel: channel.id });
        console.log(`User bridge ${callState.userBridge.id} created for channel ${channel.id}`);

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
            channelId: channel.id,
            snoopId: snoopId,
            app: config.ari.appName,
            spy: 'in'
        });
        console.log(`Snoop channel ${callState.snoopChannel.id} created for channel ${channel.id}`);

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
        const { channel, userBridge } = callState;
        const ttsAudioStream = await this.azureService.synthesizeText(text);

        callState.playback = this.ariClient.Playback();
        const playbackFinished = new Promise(resolve => callState.playback.once('PlaybackFinished', resolve));

        if (config.app.waitForFullTtsAudio) {
            // Wait for the whole file
            const audioBuffer = await new Promise((resolve, reject) => {
                const chunks = [];
                ttsAudioStream.on('data', chunk => chunks.push(chunk));
                ttsAudioStream.on('end', () => resolve(Buffer.concat(chunks)));
                ttsAudioStream.on('error', reject);
            });
            const sound = `sound:raw,${audioBuffer.toString('base64')}`;
            await userBridge.play({ media: sound, playbackId: callState.playback.id });
        } else {
            // Stream chunk by chunk
            ttsAudioStream.on('data', async (chunk) => {
                // This method is not directly supported by ARI bridges.
                // A more complex implementation involving temporary files or a custom media server would be needed.
                // For this implementation, we will fall back to the buffered approach.
                // A true real-time stream would require a different architecture.
                console.warn("Real-time TTS streaming is complex; using buffered playback for now.");
                // As a placeholder, we will use the buffered approach even if streaming is requested.
                const audioBuffer = await new Promise((resolve, reject) => {
                    const chunks = [chunk];
                    ttsAudioStream.on('data', c => chunks.push(c));
                    ttsAudioStream.on('end', () => resolve(Buffer.concat(chunks)));
                    ttsAudioStream.on('error', reject);
                });
                const sound = `sound:raw,${audioBuffer.toString('base64')}`;
                await userBridge.play({ media: sound, playbackId: callState.playback.id });
            });
        }

        console.log(`Playback started on channel ${channel.id}`);
        await playbackFinished;
        console.log(`Playback finished on channel ${channel.id}`);
    }

    enableTalkDetection(callState) {
        const { channel } = callState;
        console.log(`Enabling talk detection on channel ${channel.id}`);

        channel.on('ChannelTalkingStarted', () => {
            console.log(`Talking started on ${channel.id}. Starting recognition.`);
            callState.isRecognizing = true;
        });

        channel.on('ChannelTalkingFinished', (event) => {
            console.log(`Talking finished on ${channel.id}. Duration: ${event.duration} ms. Stopping recognition.`);
            callState.isRecognizing = false;
            // The session will stop automatically after a short timeout.
            // We can also force it if needed, but letting Azure detect the end of speech is often better.
        });

        channel.setChannelVar({
            variable: 'TALK_DETECT(set)',
            value: `speech_threshold=${config.app.talkDetect.speechThreshold},silence_threshold=${config.app.talkDetect.silenceThreshold}`
        });
    }

    async continueInDialplan(callState) {
        if (callState.channel) {
            console.log(`Continuing in dialplan for channel ${callState.channel.id}`);
            await callState.channel.setChannelVar({ variable: 'TRANSCRIPT', value: callState.finalTranscript });
            await callState.channel.continueInDialplan();
        }
        await this.cleanup(callState);
    }

    async cleanup(callState) {
        console.log('Cleaning up resources...');
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
