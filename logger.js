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

const log = (level, currentLogLevel, context, ...args) => {
    const levelValue = LOG_LEVELS[level.toLowerCase()];
    if (levelValue === undefined || levelValue < currentLogLevel) {
        return;
    }

    const contextString = context ? `[${context.uniqueId || ''}][${context.callerId || ''}]` : '';

    const message = args.map(arg => {
        if (typeof arg === 'object' && arg !== null) {
            // Use a more robust serialization
            return JSON.stringify(arg, (key, value) =>
                typeof value === 'bigint' ? value.toString() : value, 2);
        }
        return arg;
    }).join(' ');

    const formattedMessage = `[${getTimestamp()}] [${level.toUpperCase()}] ${contextString} ${message}`;

    if (level === 'error') {
        console.error(formattedMessage);
    } else {
        console.log(formattedMessage);
    }
};

const createLogger = (loggerConfig = { context: null, config: globalConfig }) => {
    const { context, config } = loggerConfig;
    const currentLogLevel = LOG_LEVELS[config.logging.level.toLowerCase()] || LOG_LEVELS.info;

    return {
        info: (...args) => log('info', currentLogLevel, context, ...args),
        warn: (...args) => log('warn', currentLogLevel, context, ...args),
        error: (...args) => log('error', currentLogLevel, context, ...args),
        debug: (...args) => log('debug', currentLogLevel, context, ...args),
        isLevelEnabled: (level) => {
            const targetLevel = LOG_LEVELS[level.toLowerCase()];
            if (targetLevel === undefined) {
                return false;
            }
            return targetLevel >= currentLogLevel;
        }
    };
};

module.exports = createLogger;
