'use strict';

const { ulawToPCM } = require('g711');

/**
 * Converts a buffer of audio data from u-law format to 16-bit linear PCM format.
 * Asterisk typically sends audio in u-law format over RTP. Azure Speech Service
 * requires linear PCM for speech recognition.
 *
 * @param {Buffer} ulawAudioBuffer - The buffer containing u-law encoded audio data.
 * @returns {Buffer} A new buffer containing the audio data in 16-bit linear PCM format.
 */
function ulawToPcm(ulawAudioBuffer) {
    // Decode MULAW payload to an Int16Array.
    const pcmInt16Array = ulawToPCM(ulawAudioBuffer);
    // Convert the Int16Array to a Buffer for Azure's stream.
    return Buffer.from(pcmInt16Array.buffer);
}

module.exports = {
    ulawToPcm,
};
