'use strict';

const dotenv = require('dotenv');
const path = require('path');

// Cargar variables de entorno desde el archivo .env
const result = dotenv.config();

if (result.error) {
    console.warn("Warning: .env file not found. Falling back to environment variables.");
}

const config = {
    ari: {
        url: process.env.ARI_URL || 'http://127.0.0.1:8088',
        username: process.env.ARI_USERNAME || 'asterisk',
        password: process.env.ARI_PASSWORD || 'asterisk',
        appName: process.env.ARI_APP_NAME || 'speech-to-text-app',
    },
    azure: {
        subscriptionKey: process.env.AZURE_SPEECH_SUBSCRIPTION_KEY,
        region: process.env.AZURE_SPEECH_REGION,
        tts: {
            language: process.env.AZURE_TTS_LANGUAGE || 'es-ES',
            voiceName: process.env.AZURE_TTS_VOICE_NAME || 'es-ES-ElviraNeural',
            outputFormat: process.env.AZURE_TTS_OUTPUT_FORMAT || 'Riff8Khz16BitMonoPcm',
        },
        stt: {
            language: process.env.AZURE_STT_LANGUAGE || 'es-ES',
        },
    },
    app: {
        talkDetect: {
            silenceThreshold: parseInt(process.env.TALK_DETECT_SILENCE_THRESHOLD, 10) || 1200,
            speechThreshold: parseInt(process.env.TALK_DETECT_SPEECH_THRESHOLD, 10) || 500,
        },
        vad: {
            activationMode: process.env.VAD_ACTIVATION_MODE || 'after_prompt_start',
            activationDelay: parseInt(process.env.VAD_ACTIVATION_DELAY_MS, 10) || 500,
        },
        timeouts: {
            session: parseInt(process.env.ARI_SESSION_TIMEOUT_MS, 10) || 60000,
            noInput: parseInt(process.env.NO_INPUT_TIMEOUT_MS, 10) || 10000,
        },
        dtmf: {
            enabled: (process.env.ENABLE_DTMF || 'true').toLowerCase() === 'true',
            completionTimeout: parseInt(process.env.DTMF_COMPLETION_TIMEOUT_MS, 10) || 2000,
        }
    },
    rtpServer: {
        ip: process.env.EXTERNAL_MEDIA_SERVER_IP || '127.0.0.1',
        port: parseInt(process.env.EXTERNAL_MEDIA_SERVER_PORT, 10) || 16000,
        audioFormat: process.env.EXTERNAL_MEDIA_AUDIO_FORMAT || 'ulaw',
        preBufferSize: parseInt(process.env.RTP_PREBUFFER_SIZE, 10) || 100,
    },
    logging: {
        level: process.env.LOG_LEVEL || 'info',
    },
    database: {
        dialect: process.env.DB_DIALECT || 'sqlite',
        storage: process.env.DB_STORAGE || './database/dev.sqlite', // For sqlite
        host: process.env.DB_HOST,
        port: process.env.DB_PORT,
        username: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_DATABASE,
    }
};

// Validar configuración esencial
if (!config.azure.subscriptionKey || !config.azure.region) {
    console.error("Azure subscription key or region is not configured. Please set AZURE_SPEECH_SUBSCRIPTION_KEY and AZURE_SPEECH_REGION in your .env file or environment variables.");
    process.exit(1);
}

module.exports = config;
