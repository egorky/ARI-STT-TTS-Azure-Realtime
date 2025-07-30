'use strict';

/**
 * Creates a WAV file header.
 * @param {object} options - Options for the WAV header.
 * @param {number} options.numChannels - Number of channels (1 for mono, 2 for stereo).
 * @param {number} options.sampleRate - The sample rate (e.g., 8000, 16000).
 * @param {number} options.bitDepth - The bit depth (e.g., 16).
 * @param {number} dataLength - The length of the raw PCM data in bytes.
 * @returns {Buffer} A buffer containing the 44-byte WAV header.
 */
function createWavHeader({ numChannels, sampleRate, bitDepth }, dataLength) {
    const header = Buffer.alloc(44);
    const blockAlign = numChannels * (bitDepth / 8);
    const byteRate = sampleRate * blockAlign;

    // RIFF identifier
    header.write('RIFF', 0);
    // File length (36 bytes for header + dataLength)
    header.writeUInt32LE(36 + dataLength, 4);
    // WAVE identifier
    header.write('WAVE', 8);
    // FMT chunk identifier
    header.write('fmt ', 12);
    // FMT chunk length (16 for PCM)
    header.writeUInt32LE(16, 16);
    // Audio format (1 for PCM)
    header.writeUInt16LE(1, 20);
    // Number of channels
    header.writeUInt16LE(numChannels, 22);
    // Sample rate
    header.writeUInt32LE(sampleRate, 24);
    // Byte rate
    header.writeUInt32LE(byteRate, 28);
    // Block align
    header.writeUInt16LE(blockAlign, 32);
    // Bits per sample
    header.writeUInt16LE(bitDepth, 34);
    // DATA chunk identifier
    header.write('data', 36);
    // Data chunk length
    header.writeUInt32LE(dataLength, 40);

    return header;
}


/**
 * Prepends a WAV header to a raw PCM audio buffer.
 * @param {Buffer} pcmData - The raw PCM audio data.
 * @param {object} options - Options for the WAV header.
 * @param {number} options.numChannels - Number of channels (1 for mono, 2 for stereo).
 * @param {number} options.sampleRate - The sample rate (e.g., 8000, 16000).
 * @param {number} options.bitDepth - The bit depth (e.g., 16).
 * @returns {Buffer} A new buffer containing the complete WAV file data.
 */
function addWavHeader(pcmData, options) {
    const header = createWavHeader(options, pcmData.length);
    return Buffer.concat([header, pcmData]);
}

module.exports = {
    addWavHeader
};
