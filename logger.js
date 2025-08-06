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
                // This specific format string will produce the desired output.
                messageFormat: '{levelLabel} {if uniqueId}[{uniqueId}]{end}{if callerId}[{callerId}]{end} - {msg}',
                // Ignoring pid and the keys that are now part of the custom message format is crucial.
                ignore: 'pid,hostname,uniqueId,callerId,time',
                translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l',
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
