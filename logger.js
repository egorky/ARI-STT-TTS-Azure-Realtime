'use strict';

const pino = require('pino');
const globalConfig = require('./config');

const createLogger = (loggerConfig = { context: null, config: globalConfig }) => {
    const { context = null, config = globalConfig } = loggerConfig;

    const pinoConfig = {
        level: config.logging.level || 'info',
        transport: {
            target: 'pino-pretty',
            options: {
                colorize: true,
                sync: true, // Run in main thread to allow for function messageFormat
                translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l',
                ignore: 'pid,hostname,time', // Ignore original time, we use the translated one
                messageFormat: (log, messageKey, levelLabel) => {
                    const msg = log[messageKey];
                    const uniqueId = log.uniqueId ? `[${log.uniqueId}]` : '';
                    const callerId = log.callerId ? `[${log.callerId}]` : '';
                    return `${levelLabel.toUpperCase()} ${uniqueId}${callerId} - ${msg}`;
                },
            },
        },
    };

    const logger = pino(pinoConfig);

    if (context) {
        return logger.child(context);
    }

    return logger;
};

module.exports = createLogger;
