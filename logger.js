'use strict';

const config = require('./config');

const LOG_LEVELS = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
};

const currentLogLevel = LOG_LEVELS[config.logging.level.toLowerCase()] || LOG_LEVELS.info;

const getTimestamp = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ` +
           `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}` +
           `.${String(d.getMilliseconds()).padStart(3, '0')}`;
};

const log = (level, context, ...args) => {
    if (LOG_LEVELS[level] < currentLogLevel) {
        return;
    }

    const contextString = context ? `[${context.uniqueId || ''}][${context.callerId || ''}]` : '';

    const message = args.map(arg => {
        if (typeof arg === 'object' && arg !== null) {
            return JSON.stringify(arg, null, 2);
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

const createLogger = (context = null) => ({
    info: (...args) => log('info', context, ...args),
    warn: (...args) => log('warn', context, ...args),
    error: (...args) => log('error', context, ...args),
    debug: (...args) => log('debug', context, ...args),
});

module.exports = createLogger;
