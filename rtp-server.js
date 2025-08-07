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

        // --- Circular Buffer for Pre-Buffering ---
        this.preBufferSize = preBufferSize;
        this.preBuffer = [];
        this.isRecognizing = false; // Flag to control audio processing

        this.socket.on('error', (err) => {
            this.logger.error(`RTP Server Error:\n${err.stack}`);
            this.socket.close();
            this.emit('error', err);
        });

        this.socket.on('message', (msg) => {
            const audioPayload = msg.slice(12); // Extract audio payload from RTP packet

            if (this.isRecognizing) {
                // If recognition is active, emit the packet immediately.
                this.emit('audioPacket', audioPayload);
            } else {
                // Otherwise, keep filling the circular pre-buffer.
                this.preBuffer.push(audioPayload);
                if (this.preBuffer.length > this.preBufferSize) {
                    this.preBuffer.shift(); // Maintain the size of the circular buffer
                }
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

    /**
     * Flushes the current pre-buffer and starts emitting real-time packets.
     * @returns {Buffer} The concatenated audio data from the pre-buffer.
     */
    flushPreBuffer() {
        this.logger.info(`Flushing pre-buffer with ${this.preBuffer.length} packets.`);
        const flushedAudio = Buffer.concat(this.preBuffer);
        this.preBuffer = []; // Clear the buffer
        this.isRecognizing = true; // Switch to real-time emission
        return flushedAudio;
    }

    /**
     * Stops the server and closes the socket.
     */
    close() {
        if (this.socket) {
            this.socket.close();
            this.logger.info('RTP Server stopped.');
        }
    }
}

module.exports = RtpServer;
