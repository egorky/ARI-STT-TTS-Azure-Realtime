'use strict';

const dgram = require('dgram');
const EventEmitter = require('events');
const logger = require('./logger');

/**
 * A simple RTP server to receive audio streams from Asterisk.
 * It listens on a UDP port, extracts the audio payload from RTP packets,
 * and emits it.
 */
class RtpServer extends EventEmitter {
    constructor() {
        super();
        this.socket = dgram.createSocket('udp4');
        this.address = null;

        this.socket.on('error', (err) => {
            logger.error(`RTP Server Error:\n${err.stack}`);
            this.socket.close();
            this.emit('error', err);
        });

        this.jitterBuffer = new Map();
        this.lastPlayedSeq = -1;
        this.isPlaying = false;
        this.intervalId = null;

        this.socket.on('message', (msg) => {
            const sequenceNumber = msg.readUInt16BE(2);
            const audioPayload = msg.slice(12);

            this.jitterBuffer.set(sequenceNumber, audioPayload);

            if (!this.isPlaying) {
                this.startPlayback();
            }
        });

        this.socket.on('listening', () => {
            this.address = this.socket.address();
            logger.info(`RTP Server listening on ${this.address.address}:${this.address.port}`);
            this.emit('listening', this.address);
        });
    }

    /**
     * Starts listening on a specified IP and port.
     * @param {string} ip - The IP address to bind to.
     * @param {number} startPort - The initial port to try binding to.
     * @returns {Promise<object>} A promise that resolves with the listening address.
     */
    listen(ip, startPort) {
        return new Promise((resolve, reject) => {
            const tryBind = (port) => {
                this.socket.once('listening', () => {
                    // Remove the error listener to avoid multiple rejects
                    this.socket.removeListener('error', onError);
                    resolve(this.socket.address());
                });

                const onError = (err) => {
                    if (err.code === 'EADDRINUSE') {
                        logger.warn(`Port ${port} is in use, trying next one.`);
                        this.socket.close();
                        this.socket = dgram.createSocket('udp4'); // Re-create socket
                        tryBind(port + 1); // Try the next port
                    } else {
                        reject(err);
                    }
                };

                this.socket.once('error', onError);
                this.socket.bind(port, ip);
            };

            tryBind(startPort);
        });
    }

    /**
     * Closes the UDP socket.
     */
    startPlayback() {
        this.isPlaying = true;
        // A threshold to decide when to skip a lost packet. 5 * 20ms = 100ms
        const MAX_MISSES = 5;
        let missCount = 0;

        this.intervalId = setInterval(() => {
            if (this.jitterBuffer.size === 0) {
                return; // Nothing to play
            }

            if (this.lastPlayedSeq === -1) {
                // Initialize with the smallest sequence number in the buffer
                this.lastPlayedSeq = Math.min(...this.jitterBuffer.keys()) - 1;
            }

            const nextSeq = (this.lastPlayedSeq + 1) % 65536;

            if (this.jitterBuffer.has(nextSeq)) {
                missCount = 0; // Reset miss counter
                const audioPayload = this.jitterBuffer.get(nextSeq);
                this.emit('audioPacket', audioPayload);
                this.jitterBuffer.delete(nextSeq);
                this.lastPlayedSeq = nextSeq;
            } else {
                // Packet is missing
                missCount++;
                if (missCount > MAX_MISSES) {
                    // We've waited long enough, skip to the next available packet
                    const availableKeys = Array.from(this.jitterBuffer.keys());
                    // Find a key that is "close" to the one we expect, to handle wrap-around
                    const nextAvailableSeq = availableKeys.sort((a, b) => {
                        const diffA = Math.abs(a - nextSeq);
                        const diffB = Math.abs(b - nextSeq);
                        return diffA - diffB;
                    })[0];

                    if (nextAvailableSeq !== undefined) {
                        logger.warn(`RTP packet ${nextSeq} lost. Skipping to next available packet ${nextAvailableSeq}.`);
                        this.lastPlayedSeq = nextAvailableSeq - 1;
                    }
                    missCount = 0;
                }
            }
        }, 20); // Process packets every 20ms
    }

    close() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
        }
        if (this.socket) {
            this.socket.close();
            logger.info('RTP Server stopped.');
        }
    }
}

module.exports = RtpServer;
