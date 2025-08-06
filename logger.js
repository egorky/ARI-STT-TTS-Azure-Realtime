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
                translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l',
                // This format includes time, level, context, and message.
                messageFormat: '[{time}] {levelLabel} {if uniqueId}[{uniqueId}]{end}{if callerId}[{callerId}]{end} - {msg}',
                // Ignore the original keys that are now part of the custom message format.
                ignore: 'pid,hostname,time,level,uniqueId,callerId',
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
