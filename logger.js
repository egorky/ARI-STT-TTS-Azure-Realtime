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

const formatMessage = (level, context, args) => {
    const timestamp = getTimestamp();
    const levelStr = `[${level.toUpperCase()}]`;
    const contextStr = context ? `[${context.uniqueId || 'N/A'}][${context.callerId || 'N/A'}]` : '';

    const message = args.map(arg => {
        if (typeof arg === 'object' && arg !== null) {
            try {
                return JSON.stringify(arg, (key, value) =>
                    typeof value === 'bigint' ? value.toString() : value, 2);
            } catch (e) {
                return '[Unserializable Object]';
            }
        }
        return arg;
    }).join(' ');

    return `${timestamp} ${levelStr} ${contextStr} ${message}`;
};


const log = (level, config, context, ...args) => {
    const configuredLevelName = (config.logging.level || 'info').toLowerCase();
    const configuredLevelValue = LOG_LEVELS[configuredLevelName];
    const messageLevelValue = LOG_LEVELS[level.toLowerCase()];

    if (messageLevelValue >= configuredLevelValue) {
        const formattedMessage = formatMessage(level, context, args);
        // Use setImmediate to make the I/O non-blocking
        setImmediate(() => {
            if (level === 'error') {
                console.error(formattedMessage);
            } else {
                console.log(formattedMessage);
            }
        });
    }
};

const createLogger = (loggerConfig = { context: null, config: globalConfig }) => {
    const { context = null, config = globalConfig } = loggerConfig;

    return {
        info: (...args) => log('info', config, context, ...args),
        warn: (...args) => log('warn', config, context, ...args),
        error: (...args) => log('error', config, context, ...args),
        debug: (...args) => log('debug', config, context, ...args),
    };
};

module.exports = createLogger;
