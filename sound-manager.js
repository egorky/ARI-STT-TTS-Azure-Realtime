'use strict';

const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const { v4: uuidv4 } = require('uuid');
const createLogger = require('./logger');

const globalLogger = createLogger();
const TEMP_DIR_NAME = 'ari-tts-cache';
const tempDir = path.join(os.tmpdir(), TEMP_DIR_NAME);

/**
 * Initializes the sound manager by ensuring the temporary directory exists.
 * @returns {Promise<void>}
 */
async function initialize() {
    try {
        await fs.mkdir(tempDir, { recursive: true });
        globalLogger.info(`Temporary audio directory is ready at: ${tempDir}`);
    } catch (err) {
        globalLogger.error('Failed to create temporary audio directory:', err);
        throw err;
    }
}

const { addWavHeader } = require('./wav-helper');

/**
 * Saves a raw PCM audio buffer to a temporary, valid WAV file.
 * The filename is unique.
 * @param {Buffer} pcmAudioBuffer - The raw PCM audio data.
 * @returns {Promise<object>} A promise that resolves with an object containing the full path and the sound URI.
 */
async function saveTempAudio(pcmAudioBuffer, logger) {
    const filename = `${uuidv4()}.wav`;
    const filePath = path.join(tempDir, filename);

    try {
        // Hardcoding format based on Azure's output 'Riff8Khz16BitMonoPcm'
        const wavOptions = {
            numChannels: 1,
            sampleRate: 8000,
            bitDepth: 16,
        };
        const wavBuffer = addWavHeader(pcmAudioBuffer, wavOptions);

        await fs.writeFile(filePath, wavBuffer);

        // The sound URI for ARI playback should not include the file extension.
        const soundUri = `sound:${path.join(tempDir, filename.replace('.wav', ''))}`;

        return { filePath, soundUri };
    } catch (err) {
        (logger || globalLogger).error(`Failed to save temporary audio file: ${filePath}`, err);
        throw err;
    }
}

/**
 * Deletes a temporary audio file.
 * @param {string} filePath - The full path to the file to delete.
 * @returns {Promise<void>}
 */
async function cleanupTempAudio(filePath, logger) {
    if (!filePath) return;
    try {
        await fs.unlink(filePath);
    } catch (err) {
        // Ignore errors if file doesn't exist, but log others.
        if (err.code !== 'ENOENT') {
            logger.error(`Failed to clean up temporary audio file: ${filePath}`, err);
        }
    }
}

const RECORDINGS_DIR_NAME = 'recordings';

/**
 * Saves a complete audio buffer to a permanent file.
 * @param {Buffer} audioBuffer - The complete audio data.
 * @param {string} type - The type of audio ('tts' or 'stt').
 * @param {object} metadata - Metadata for the filename.
 * @param {string} metadata.uniqueId - The unique channel ID.
 * @param {string} metadata.callerId - The caller's ID.
 * @param {object} logger - The logger instance for the call.
 * @returns {Promise<string|null>} The path to the saved file or null on error.
 */
async function saveFinalAudio(audioBuffer, type, metadata, logger) {
    const { uniqueId, callerId } = metadata;
    const recordingsDir = path.join(process.cwd(), RECORDINGS_DIR_NAME, type);
    await fs.mkdir(recordingsDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/:/g, '-');
    const filename = `${uniqueId}_${callerId}_${timestamp}_${type}.wav`;
    const filePath = path.join(recordingsDir, filename);

    try {
        // For STT audio, we receive raw u-law, so it needs conversion before adding a WAV header.
        // For TTS, we already have PCM data from Azure.
        // The conversion is handled in ari-client, so we assume PCM here.
        const wavOptions = {
            numChannels: 1,
            sampleRate: 8000,
            bitDepth: 16,
        };
        const wavBuffer = addWavHeader(audioBuffer, wavOptions);
        await fs.writeFile(filePath, wavBuffer);
        (logger || globalLogger).info(`Saved final audio to ${filePath}`);
        return filePath;
    } catch (err) {
        (logger || globalLogger).error(`Failed to save final audio to ${filePath}:`, err);
        return null;
    }
}

module.exports = {
    initialize,
    saveTempAudio,
    cleanupTempAudio,
    saveFinalAudio,
};
