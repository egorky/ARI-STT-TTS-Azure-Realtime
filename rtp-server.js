'use strict';

const dgram = require('dgram');
const EventEmitter = require('events');
const createLogger = require('./logger');

const globalLogger = createLogger(); // Fallback logger

class RtpServer extends EventEmitter {
    constructor(logger, preBufferSize = 100) {
        super();
        this.logger = logger || globalLogger;
        this.socket = dgram.createSocket('udp4');
        this.address = null;

        // Jitter buffer and circular pre-buffer
        this.jitterBuffer = new Map();
        this.preBuffer = [];
        this.preBufferSize = preBufferSize;
        this.lastPlayedSeq = -1;
        this.isPlaying = false;
        this.intervalId = null;
        this.isRecognizing = false;

        this.socket.on('error', (err) => {
            this.logger.error(`RTP Server Error:\n${err.stack}`);
            this.socket.close();
            this.emit('error', err);
        });

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
            this.logger.info(`RTP Server listening on ${this.address.address}:${this.address.port}`);
            this.emit('listening', this.address);
        });
    }

    listen(ip, startPort) {
        return new Promise((resolve, reject) => {
            const tryBind = (port) => {
                this.socket.once('listening', () => {
                    this.socket.removeListener('error', onError);
                    resolve(this.socket.address());
                });

                const onError = (err) => {
                    if (err.code === 'EADDRINUSE') {
                        this.logger.warn(`Port ${port} is in use, trying next one.`);
                        this.socket.close();
                        this.socket = dgram.createSocket('udp4');
                        tryBind(port + 1);
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

    startPlayback() {
        this.isPlaying = true;
        const MAX_MISSES = 5;
        let missCount = 0;

        this.intervalId = setInterval(() => {
            if (this.jitterBuffer.size === 0) return;

            if (this.lastPlayedSeq === -1) {
                this.lastPlayedSeq = Math.min(...this.jitterBuffer.keys()) - 1;
            }

            const nextSeq = (this.lastPlayedSeq + 1) % 65536;

            if (this.jitterBuffer.has(nextSeq)) {
                missCount = 0;
                const audioPayload = this.jitterBuffer.get(nextSeq);

                if (this.isRecognizing) {
                    this.emit('audioPacket', audioPayload);
                } else {
                    this.preBuffer.push(audioPayload);
                    if (this.preBuffer.length > this.preBufferSize) {
                        this.preBuffer.shift();
                    }
                }

                this.jitterBuffer.delete(nextSeq);
                this.lastPlayedSeq = nextSeq;
            } else {
                missCount++;
                if (missCount > MAX_MISSES) {
                    const sortedKeys = Array.from(this.jitterBuffer.keys()).sort((a, b) => {
                        const diffA = (a - nextSeq + 65536) % 65536;
                        const diffB = (b - nextSeq + 65536) % 65536;
                        return diffA - diffB;
                    });
                    const nextAvailableSeq = sortedKeys[0];

                    if (nextAvailableSeq !== undefined) {
                        this.logger.warn(`RTP packet ${nextSeq} lost. Skipping to next available packet ${nextAvailableSeq}.`);
                        this.lastPlayedSeq = nextAvailableSeq - 1;
                    }
                    missCount = 0;
                }
            }
        }, 20);
    }

    flushPreBuffer() {
        this.logger.info(`Flushing pre-buffer with ${this.preBuffer.length} packets.`);
        const flushedAudio = Buffer.concat(this.preBuffer);
        this.preBuffer = [];
        this.isRecognizing = true;
        return flushedAudio;
    }

    close() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
        }
        if (this.socket) {
            this.socket.close();
            this.logger.info('RTP Server stopped.');
        }
    }
}

module.exports = RtpServer;
