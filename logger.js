'use strict';

const pino = require('pino');
const globalConfig = require('./config');
const path = require('path');

const createLogger = (loggerConfig = { context: null, config: globalConfig }) => {
    const { context = null, config = globalConfig } = loggerConfig;

    const pinoConfig = {
        level: config.logging.level || 'info',
        transport: {
            target: 'pino-pretty',
            options: {
                colorize: true,
                translateTime: 'SYS:standard',
                ignore: 'pid,hostname',
                messageFormat: require(path.join(__dirname, 'logger-formatter.js')),
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
