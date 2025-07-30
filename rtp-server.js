'use strict';

const dgram = require('dgram');
const EventEmitter = require('events');

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
            console.error(`RTP Server Error:\n${err.stack}`);
            this.socket.close();
            this.emit('error', err);
        });

        this.socket.on('message', (msg) => {
            // RTP header is 12 bytes. Audio payload starts at byte 13.
            const audioPayload = msg.slice(12);
            this.emit('audioPacket', audioPayload);
        });

        this.socket.on('listening', () => {
            this.address = this.socket.address();
            console.log(`RTP Server listening on ${this.address.address}:${this.address.port}`);
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
                        console.warn(`Port ${port} is in use, trying next one.`);
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
    close() {
        if (this.socket) {
            this.socket.close();
            console.log('RTP Server stopped.');
        }
    }
}

module.exports = RtpServer;
