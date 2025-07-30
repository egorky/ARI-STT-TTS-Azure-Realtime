'use strict';

const g711 = require('g711');

/**
 * Converts a buffer of audio data from u-law format to 16-bit linear PCM format.
 * Asterisk typically sends audio in u-law format over RTP. Azure Speech Service
 * requires linear PCM for speech recognition.
 *
 * @param {Buffer} ulawAudioBuffer - The buffer containing u-law encoded audio data.
 * @returns {Buffer} A new buffer containing the audio data in 16-bit linear PCM format.
 */
function ulawToPcm(ulawAudioBuffer) {
    // The g711 library decodes u-law to 16-bit signed integers (PCM).
    // The decode function returns a Buffer, which is exactly what we need.
    return g711.ulaw2pcm(ulawAudioBuffer);
}

module.exports = {
    ulawToPcm,
};
