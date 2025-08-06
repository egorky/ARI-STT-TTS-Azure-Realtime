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
                translateTime: 'SYS:standard',
                ignore: 'pid,hostname',
                messageFormat: (log, messageKey) => {
                    const uniqueId = log.uniqueId || 'N/A';
                    const callerId = log.callerId || 'N/A';
                    const msg = log[messageKey];
                    // Manually assemble the message to ensure context is in the right place
                    let finalMsg = `[${uniqueId}][${callerId}] ${msg}`;
                    // Append other properties from the log object, like in the default pino-pretty format
                    const otherKeys = Object.keys(log).filter(key => !['level', 'time', 'pid', 'hostname', 'msg', 'uniqueId', 'callerId', 'context'].includes(key) && key !== messageKey);
                    if (otherKeys.length > 0) {
                        const otherProps = otherKeys.reduce((acc, key) => {
                            acc[key] = log[key];
                            return acc;
                        }, {});
                        finalMsg += `\n${JSON.stringify(otherProps, null, 2)}`;
                    }
                    return finalMsg;
                }
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
