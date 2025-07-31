'use strict';

const sdk = require('microsoft-cognitiveservices-speech-sdk');
const EventEmitter = require('events');
const { PassThrough } = require('stream');
const createLogger = require('./logger');

/**
 * Manages interactions with Azure Speech Services for both
 * Text-to-Speech (TTS) and Speech-to-Text (STT).
 */
class AzureService extends EventEmitter {
    constructor(config, logger) {
        super();
        this.logger = logger || createLogger();
        this.speechConfig = sdk.SpeechConfig.fromSubscription(config.azure.subscriptionKey, config.azure.region);

        // TTS Configuration
        this.speechConfig.speechSynthesisLanguage = config.azure.tts.language;
        this.speechConfig.speechSynthesisVoiceName = config.azure.tts.voiceName;
        // The output format must match what Asterisk can play.
        // e.g., Riff8Khz16BitMonoPcm
        this.speechConfig.speechSynthesisOutputFormat = sdk.SpeechSynthesisOutputFormat[config.azure.tts.outputFormat];

        // STT Configuration
        this.speechConfig.speechRecognitionLanguage = config.azure.stt.language;

        this.sttRecognizer = null;
        this.sttPushStream = null;
    }

    /**
     * Synthesizes text to an audio stream.
     * @param {string} text - The text to synthesize.
     * @returns {Promise<PassThrough>} A promise that resolves with a stream of audio data.
     */
    synthesizeText(text) {
        return new Promise((resolve, reject) => {
            const audioStream = new PassThrough();

            const pushStream = sdk.PushAudioOutputStream.create({
                write: (buffer) => {
                    audioStream.push(Buffer.from(buffer));
                },
                close: () => {
                    audioStream.push(null); // End the stream
                },
            });

            const audioConfig = sdk.AudioConfig.fromStreamOutput(pushStream);
            const synthesizer = new sdk.SpeechSynthesizer(this.speechConfig, audioConfig);

            synthesizer.speakTextAsync(
                text,
                result => {
                    if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
                        this.logger.info("Azure TTS synthesis completed.");
                    } else {
                        this.logger.error(`Azure TTS synthesis failed: ${result.errorDetails}`);
                        audioStream.emit('error', new Error(result.errorDetails));
                    }
                    synthesizer.close();
                },
                err => {
                    this.logger.error(`Azure TTS synthesis error: ${err}`);
                    audioStream.emit('error', err);
                    synthesizer.close();
                    reject(err);
                }
            );

            resolve(audioStream);
        });
    }

    /**
     * Starts a continuous speech recognition session.
     * Audio should be pushed to the stream provided by the 'audioStreamReady' event.
     */
    startContinuousRecognition() {
        const audioFormat = sdk.AudioStreamFormat.getWaveFormatPCM(8000, 16, 1);
        this.sttPushStream = sdk.AudioInputStream.createPushStream(audioFormat);
        const audioConfig = sdk.AudioConfig.fromStreamInput(this.sttPushStream);
        this.sttRecognizer = new sdk.SpeechRecognizer(this.speechConfig, audioConfig);

        let recognizedText = '';

        this.sttRecognizer.recognizing = (s, e) => {
            this.logger.info(`Azure STT Intermediate result: ${e.result.text}`);
            this.emit('recognizing', { text: e.result.text });
        };

        this.sttRecognizer.recognized = (s, e) => {
            if (e.result.reason === sdk.ResultReason.RecognizedSpeech) {
                this.logger.info(`Azure STT Final result: ${e.result.text}`);
                if (e.result.text) {
                    recognizedText += e.result.text + ' ';
                }
            }
        };

        this.sttRecognizer.canceled = (s, e) => {
            this.logger.error(`Azure STT Canceled: ${e.reason}`);
            if (e.reason === sdk.CancellationReason.Error) {
                this.logger.error(`Cancellation Details: ${e.errorDetails}`);
            }
            this.emit('recognitionError', new Error(e.errorDetails));
            this.stopContinuousRecognition();
        };

        this.sttRecognizer.sessionStopped = (s, e) => {
            this.logger.info("Azure STT session stopped.");
            this.emit('recognitionEnded', { finalText: recognizedText.trim() });
            this.stopContinuousRecognition();
        };

        this.sttRecognizer.startContinuousRecognitionAsync(
            () => {
                this.logger.info("Azure STT continuous recognition started.");
                this.emit('audioStreamReady', this.sttPushStream);
            },
            (err) => {
                this.logger.error(`Error starting Azure STT recognition: ${err}`);
                this.emit('recognitionError', new Error(err));
            }
        );
    }

    /**
     * Stops the continuous speech recognition session.
     */
    stopContinuousRecognition() {
        if (this.sttRecognizer) {
            this.sttRecognizer.stopContinuousRecognitionAsync(() => {
                this.sttRecognizer.close();
                this.sttRecognizer = null;
            });
        }
        if (this.sttPushStream) {
            this.sttPushStream.close();
            this.sttPushStream = null;
        }
    }
}

module.exports = AzureService;
