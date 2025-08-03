'use strict';

const globalConfig = require('./config');

const LOG_LEVELS = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
};

const getTimestamp = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ` +
           `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}` +
           `.${String(d.getMilliseconds()).padStart(3, '0')}`;
};

const log = (level, config, context, ...args) => {
    const configuredLevelName = (config.logging.level || 'info').toLowerCase();
    const configuredLevelValue = LOG_LEVELS[configuredLevelName];
    const messageLevelValue = LOG_LEVELS[level.toLowerCase()];

    // This check is the core of the logger.
    // It ensures that we only print messages that are at or above the configured log level.
    if (messageLevelValue >= configuredLevelValue) {
        const contextString = context ? `[${context.uniqueId || 'N/A'}][${context.callerId || 'N/A'}]` : '';

        const message = args.map(arg => {
            if (typeof arg === 'object' && arg !== null) {
                try {
                    // Use a more robust serialization that handles BigInt and avoids circular references.
                    return JSON.stringify(arg, (key, value) =>
                        typeof value === 'bigint' ? value.toString() : value, 2);
                } catch (e) {
                    return '[Unserializable Object]';
                }
            }
            return arg;
        }).join(' ');

        const formattedMessage = `[${getTimestamp()}] [${level.toUpperCase()}] ${contextString} ${message}`;

        if (level === 'error') {
            console.error(formattedMessage);
        } else {
            // For debug messages, add extra diagnostic info to see why it's being logged.
            if (level === 'debug') {
                const diagnostic = `(DIAGNOSTIC: Message level '${level}' (${messageLevelValue}) >= Configured level '${configuredLevelName}' (${configuredLevelValue}))`;
                console.log(`${formattedMessage} ${diagnostic}`);
            } else {
                console.log(formattedMessage);
            }
        }
    }
};

const createLogger = (loggerConfig = { context: null, config: globalConfig }) => {
    // Ensure that loggerConfig and its properties have default values to prevent errors.
    const { context = null, config = globalConfig } = loggerConfig;

    // The log level is now determined inside the `log` function itself,
    // making the logger instance independent of the log level at creation time.
    return {
        info: (...args) => log('info', config, context, ...args),
        warn: (...args) => log('warn', config, context, ...args),
        error: (...args) => log('error', config, context, ...args),
        debug: (...args) => log('debug', config, context, ...args),
        isLevelEnabled: (level) => {
            const configuredLevelValue = LOG_LEVELS[(config.logging.level || 'info').toLowerCase()];
            const targetLevel = LOG_LEVELS[level.toLowerCase()];
            if (targetLevel === undefined) {
                return false;
            }
            return targetLevel >= configuredLevelValue;
        }
    };
};

module.exports = createLogger;
