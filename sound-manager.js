'use strict';

const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const { v4: uuidv4 } = require('uuid');

const TEMP_DIR_NAME = 'ari-tts-cache';
const tempDir = path.join(os.tmpdir(), TEMP_DIR_NAME);

/**
 * Initializes the sound manager by ensuring the temporary directory exists.
 * @returns {Promise<void>}
 */
async function initialize() {
    try {
        await fs.mkdir(tempDir, { recursive: true });
        console.log(`Temporary audio directory is ready at: ${tempDir}`);
    } catch (err) {
        console.error('Failed to create temporary audio directory:', err);
        throw err;
    }
}

/**
 * Saves an audio buffer to a temporary WAV file.
 * The filename is unique.
 * @param {Buffer} audioBuffer - The audio data to save.
 * @returns {Promise<object>} A promise that resolves with an object containing the full path and the sound URI.
 */
async function saveTempAudio(audioBuffer) {
    const filename = `${uuidv4()}.wav`;
    const filePath = path.join(tempDir, filename);

    try {
        await fs.writeFile(filePath, audioBuffer);

        // The sound URI for ARI playback should not include the file extension.
        const soundUri = `sound:${path.join(tempDir, filename.replace('.wav', ''))}`;

        return { filePath, soundUri };
    } catch (err) {
        console.error(`Failed to save temporary audio file: ${filePath}`, err);
        throw err;
    }
}

/**
 * Deletes a temporary audio file.
 * @param {string} filePath - The full path to the file to delete.
 * @returns {Promise<void>}
 */
async function cleanupTempAudio(filePath) {
    if (!filePath) return;
    try {
        await fs.unlink(filePath);
    } catch (err) {
        // Ignore errors if file doesn't exist, but log others.
        if (err.code !== 'ENOENT') {
            console.error(`Failed to clean up temporary audio file: ${filePath}`, err);
        }
    }
}

module.exports = {
    initialize,
    saveTempAudio,
    cleanupTempAudio,
};
