'use strict';

const AriClient = require('ari-client');
const { v4: uuidv4 } = require('uuid');
const { cloneDeep, set } = require('lodash');
const RtpServer = require('./rtp-server');
const AzureService = require('./azure-service');
const { ulawToPcm } = require('./audio-converter');
const soundManager = require('./sound-manager');
const config = require('./config');
const createLogger = require('./logger');
const db = require('./database');

const logger = createLogger({ config }); // Global logger for app-level events
const DIALPLAN_VAR_PREFIX = 'APP_VAR_';

class App {
    constructor() {
        this.ariClient = null;
        // this.azureService is no longer global
        this.activeCalls = new Map(); // Track active calls by channel ID
    }

    async start() {
        try {
            await soundManager.initialize();
            this.ariClient = await AriClient.connect(config.ari.url, config.ari.username, config.ari.password);
            logger.info('Connected to Asterisk ARI');

            this.ariClient.on('StasisStart', (event, channel) => {
                // Ignore channels that are marked as internal, or channels that don't have a caller property.
                if ((event.args && event.args.includes('internal')) || !channel.caller.number) {
                    createLogger({ config }).info(`Ignoring internal or caller-less channel ${channel.id} entering Stasis.`);
                    // We answer these channels to ensure they are properly handled and don't get stuck.
                    channel.answer().catch(err => createLogger({ config }).error(`Failed to answer internal channel ${channel.id}:`, err));
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

    async getDialplanVariables(channel, logger) {
        try {
            const channelVars = await channel.getChannelVars();
            logger.debug({ channelVars }, 'Received all channel variables from Asterisk');
            return channelVars;
        } catch (err) {
            // It's possible getChannelVars() isn't supported or fails.
            logger.warn('Could not retrieve all channel variables with getChannelVars(). This may be expected depending on your Asterisk version. Falling back to predefined list.', err);

            // Fallback to a predefined list of variables
            const varsToCheck = [
                'LOG_LEVEL',
                'AZURE_TTS_LANGUAGE', 'AZURE_TTS_VOICE_NAME', 'AZURE_STT_LANGUAGE',
                'PROMPT_MODE', 'PLAYBACK_FILE_PATH', 'VAD_ACTIVATION_MODE'
            ];
            const channelVars = {};
            for (const v of varsToCheck) {
                try {
                    const fullVarName = `${DIALPLAN_VAR_PREFIX}${v}`;
                    const result = await channel.getChannelVar({ variable: fullVarName });
                    if (result && result.value) {
                        channelVars[fullVarName] = result.value;
                    }
                } catch (e) {
                    // This is expected if the variable is not set, so we don't log an error.
                }
            }
            return channelVars;
        }
    }

    createCallConfig(dialplanVars, logger) {
        const callConfig = cloneDeep(config);

        const varToPathMap = {
            // ARI
            'ARI_URL': 'ari.url',
            'ARI_USERNAME': 'ari.username',
            'ARI_PASSWORD': 'ari.password',
            'ARI_APP_NAME': 'ari.appName',
            // Azure General
            'AZURE_SPEECH_SUBSCRIPTION_KEY': 'azure.subscriptionKey',
            'AZURE_SPEECH_REGION': 'azure.region',
            // Azure TTS
            'AZURE_TTS_LANGUAGE': 'azure.tts.language',
            'AZURE_TTS_VOICE_NAME': 'azure.tts.voiceName',
            'AZURE_TTS_OUTPUT_FORMAT': 'azure.tts.outputFormat',
            // Azure STT
            'AZURE_STT_LANGUAGE': 'azure.stt.language',
            // App Behavior
            'VAD_ACTIVATION_MODE': 'app.vad.activationMode',
            'VAD_ACTIVATION_DELAY_MS': 'app.vad.activationDelay',
            'TALK_DETECT_SILENCE_THRESHOLD': 'app.talkDetect.silenceThreshold',
            'TALK_DETECT_SPEECH_THRESHOLD': 'app.talkDetect.speechThreshold',
            'PROMPT_MODE': 'app.prompt.mode',
            'PLAYBACK_FILE_PATH': 'app.prompt.playbackPath',
            // Timeouts
            'ARI_SESSION_TIMEOUT_MS': 'app.timeouts.session',
            'NO_INPUT_TIMEOUT_MS': 'app.timeouts.noInput',
            // RTP
            'RTP_PREBUFFER_SIZE': 'rtpServer.preBufferSize',
            // DTMF
            'ENABLE_DTMF': 'app.dtmf.enabled',
            'DTMF_COMPLETION_TIMEOUT_MS': 'app.dtmf.completionTimeout',
            // External Media Server
            'EXTERNAL_MEDIA_SERVER_IP': 'rtpServer.ip',
            'EXTERNAL_MEDIA_SERVER_PORT': 'rtpServer.port',
            'EXTERNAL_MEDIA_AUDIO_FORMAT': 'rtpServer.audioFormat',
            // Logging
            'LOG_LEVEL': 'logging.level',
            // Database
            'DB_DIALECT': 'database.dialect',
            'DB_STORAGE': 'database.storage',
            'DB_HOST': 'database.host',
            'DB_PORT': 'database.port',
            'DB_USER': 'database.username',
            'DB_PASSWORD': 'database.password',
            'DB_DATABASE': 'database.database',
        };

        const parseDialplanValue = (key, value) => {
            const intKeys = [
                'VAD_ACTIVATION_DELAY_MS', 'TALK_DETECT_SILENCE_THRESHOLD',
                'TALK_DETECT_SPEECH_THRESHOLD', 'ARI_SESSION_TIMEOUT_MS',
                'NO_INPUT_TIMEOUT_MS', 'RTP_PREBUFFER_SIZE',
                'DTMF_COMPLETION_TIMEOUT_MS', 'EXTERNAL_MEDIA_SERVER_PORT', 'DB_PORT'
            ];
            const boolKeys = ['ENABLE_DTMF'];

            if (intKeys.includes(key)) {
                const num = parseInt(value, 10);
                return isNaN(num) ? null : num;
            }
            if (boolKeys.includes(key)) {
                return value.toLowerCase() === 'true';
            }
            return value;
        };

        for (const [key, value] of Object.entries(dialplanVars)) {
            if (key.startsWith(DIALPLAN_VAR_PREFIX)) {
                const configKey = key.substring(DIALPLAN_VAR_PREFIX.length);
                const configPath = varToPathMap[configKey];

                if (configPath) {
                    const parsedValue = parseDialplanValue(configKey, value);
                    if (parsedValue !== null) {
                        logger.info(`Overriding config from dialplan: '${configPath}' with value '${parsedValue}'`);
                        set(callConfig, configPath, parsedValue);
                    } else {
                        logger.warn(`Could not parse value for dialplan variable ${key}: '${value}'`);
                    }
                } else {
                    logger.warn(`Unknown config override variable from dialplan: ${key}`);
                }
            }
        }

        return callConfig;
    }


    async handleCall(channel) {
        const callerId = channel.caller.number;
        const uniqueId = channel.id; // Use the full, unique channel ID

        // Create a temporary logger with default settings just for the setup phase.
        const setupLogger = createLogger({ context: { uniqueId, callerId }, config });

        // 1. Get all variables from the dialplan.
        const dialplanVars = await this.getDialplanVariables(channel, setupLogger);

        // 2. Create the final, call-specific configuration.
        const callConfig = this.createCallConfig(dialplanVars, setupLogger);

        // 3. Now, create the definitive logger for this call using the final configuration.
        const logger = createLogger({ context: { uniqueId, callerId }, config: callConfig });

        // Log the final configuration using the new logger, redacting sensitive data.
        const redactedConfig = cloneDeep(callConfig);
        if (redactedConfig.azure && redactedConfig.azure.subscriptionKey) {
            redactedConfig.azure.subscriptionKey = '[REDACTED]';
        }
        logger.debug({ finalConfig: redactedConfig }, 'Final configuration for the call');

        logger.info(`Incoming call`);

        // 4. Proceed with handling the call using the final config and logger.
        const callState = {
            logger,
            mainChannel: channel,
            config: callConfig,
            azureService: new AzureService(callConfig, logger),
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
            if (callConfig.app.timeouts.session > 0) {
                callState.timers.session = setTimeout(() => {
                    logger.warn(`Session timeout reached for channel ${channel.id}. Hanging up.`);
                    channel.hangup().catch(e => logger.error(`Error hanging up channel on session timeout:`, e));
                }, callConfig.app.timeouts.session);
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

            // 3. Handle the prompt (TTS or Playback) in the background.
            this.handlePrompt(callState, textToSpeak);

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
            logger.info(`Recognition ended. Final transcript: ${result.finalText}`);
            recognitionResolve(result.finalText || ''); // Resolve with the final text
        });

        azureService.on('recognitionError', (err) => {
            logger.error(`STT Error:`, err);
            recognitionResolve(''); // Resolve with an empty string on error to unblock the call flow
        });

        return streamReadyPromise;
    }

    async setupAudioSnooping(callState) {
        const { mainChannel, config: callConfig } = callState;

        // Create user bridge and add channel
        callState.userBridge = this.ariClient.Bridge();
        await callState.userBridge.create({ type: 'mixing' });
        await callState.userBridge.addChannel({ channel: mainChannel.id });
        callState.logger.info(`User bridge ${callState.userBridge.id} created.`);

        // Start RTP server
        callState.rtpServer = new RtpServer(callState.logger);
        const rtpServerAddress = await callState.rtpServer.listen(callConfig.rtpServer.ip, callConfig.rtpServer.port);

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
            app: callConfig.ari.appName,
            spy: 'in',
            appArgs: 'internal' // Mark this channel as internal
        });
        callState.logger.info(`Snoop channel ${callState.snoopChannel.id} created.`);

        // Create external media channel
        callState.externalMediaChannel = await this.ariClient.channels.externalMedia({
            app: callConfig.ari.appName,
            external_host: `${rtpServerAddress.address}:${rtpServerAddress.port}`,
            format: callConfig.rtpServer.audioFormat,
            appArgs: 'internal' // Mark this channel as internal
        });
        callState.logger.info(`External media channel ${callState.externalMediaChannel.id} created.`);

        // Create snoop bridge and bridge channels
        callState.snoopBridge = this.ariClient.Bridge();
        await callState.snoopBridge.create({ type: 'mixing' });
        await callState.snoopBridge.addChannel({ channel: [callState.snoopChannel.id, callState.externalMediaChannel.id] });
        callState.logger.info(`Snoop bridge ${callState.snoopBridge.id} created.`);
    }

    async handlePrompt(callState, textToSpeak) {
        const { logger, config: callConfig } = callState;
        logger.debug(`Handling prompt with mode: ${callConfig.app.prompt.mode}`);

        if (callConfig.app.prompt.mode === 'playback') {
            await this.playFileAudio(callState);
        } else {
            await this.streamTtsAudio(callState, textToSpeak);
        }
    }

    async playFileAudio(callState) {
        const { mainChannel, userBridge, logger, config: callConfig } = callState;
        const filePath = callConfig.app.prompt.playbackPath;
        if (!filePath) {
            logger.error('Prompt mode is "playback" but PLAYBACK_FILE_PATH is not set.');
            return;
        }

        logger.info(`Playing audio file: ${filePath}`);
        callState.synthesizedAudioPath = filePath; // Save the path for DB logging
        callState.isPlayingPrompt = true;

        try {
            const playback = this.ariClient.Playback();
            callState.playbackId = playback.id; // Save the playback ID
            const playbackFinished = new Promise(resolve => playback.once('PlaybackFinished', resolve));

            // Activate VAD based on config
            if (callConfig.app.vad.activationMode === 'after_prompt_start') {
                setTimeout(() => this.enableTalkDetection(callState), callConfig.app.vad.activationDelay);
            }

            await userBridge.play({ media: `sound:${filePath}`, playbackId: callState.playbackId });
            await playbackFinished;

            if (callConfig.app.vad.activationMode === 'after_prompt_end') {
                this.enableTalkDetection(callState);
            }

        } catch(err) {
            logger.error(`Error playing audio file ${filePath}:`, err);
        } finally {
            callState.isPlayingPrompt = false;
            logger.info('Finished playing prompt file.');
        }
    }

    async streamTtsAudio(callState, text) {
        const { mainChannel, userBridge, logger, azureService, config: callConfig } = callState;
        logger.info(`Synthesizing and playing prompt: "${text}"`);
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

                if (!vadEnabled && callConfig.app.vad.activationMode === 'after_prompt_start') {
                    vadEnabled = true;
                    setTimeout(() => this.enableTalkDetection(callState), callConfig.app.vad.activationDelay);
                }

                const chunk = chunkQueue.shift();

                try {
                    const tempAudioFile = await soundManager.saveTempAudio(chunk, callState.logger);
                    callState.logger.info(`Queueing chunk ${tempAudioFile.filePath} for playback.`);

                    const playback = this.ariClient.Playback();
                    callState.playbackId = playback.id; // Save the playback ID for barge-in
                    playback.once('PlaybackFinished', () => {
                        callState.playbackId = null; // Clear the ID when done
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

            if (callConfig.app.vad.activationMode === 'after_prompt_end') {
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
        const { mainChannel, userBridge, rtpServer, logger, config: callConfig } = callState;
        logger.info(`Enabling talk detection.`);

        // Start pre-buffering audio to catch the beginning of speech
        rtpServer.startPreBuffering(callConfig.rtpServer.preBufferSize);

        // Start no-input timer
        if (callConfig.app.timeouts.noInput > 0) {
            callState.timers.noInput = setTimeout(() => {
                logger.warn(`No-input timeout reached. Hanging up.`);
                mainChannel.hangup().catch(e => logger.error(`Error hanging up channel on no-input timeout:`, e));
            }, callConfig.app.timeouts.noInput);
        }

        const onTalkingStarted = async () => {
            // Once user speaks, clear the no-input timer
            clearTimeout(callState.timers.noInput);

            // This event can fire multiple times, but we only want to start the STT session once.
            // We remove the listener immediately to prevent re-entry.
            mainChannel.removeListener('ChannelTalkingStarted', onTalkingStarted);

            if (callState.isPlayingPrompt && callState.playbackId) {
                logger.info(`Barge-in detected. Stopping prompt playback ID ${callState.playbackId}.`);
                callState.isPlayingPrompt = false; // Stop the prompt loop
                try {
                    await this.ariClient.playbacks.stop({ playbackId: callState.playbackId });
                } catch (e) {
                    // This can fail if the playback already finished, which is fine.
                    logger.warn(`Could not stop playback ${callState.playbackId}, it may have already finished.`);
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

            const finalText = await callState.recognitionPromise;
            callState.finalTranscript = finalText;
            logger.info(`Final transcript to be saved: ${finalText}`);

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
                if (callState.isPlayingPrompt && callState.playbackId) {
                    logger.info(`DTMF Barge-in detected. Stopping prompt playback ID ${callState.playbackId}.`);
                    callState.isPlayingPrompt = false;
                    try {
                        await this.ariClient.playbacks.stop({ playbackId: callState.playbackId });
                    } catch (e) {
                        logger.warn(`Could not stop playback ${callState.playbackId} for DTMF, it may have already finished.`);
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
            }, callConfig.app.dtmf.completionTimeout);
        };

        // Assign listeners
        mainChannel.on('ChannelTalkingStarted', onTalkingStarted);
        mainChannel.on('ChannelTalkingFinished', onTalkingFinished);
        if (callConfig.app.dtmf.enabled) {
            mainChannel.on('ChannelDtmfReceived', onDtmfReceived);
        }

        // Setting TALK_DETECT values. Some Asterisk versions expect a positional format.
        // Format: "<silence_threshold>,<speech_threshold>"
        const talkDetectValue = `${callConfig.app.talkDetect.silenceThreshold},${callConfig.app.talkDetect.speechThreshold}`;

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
        if (callState.azureService) {
            callState.azureService.stopContinuousRecognition();
        }
    }
}

module.exports = App;
