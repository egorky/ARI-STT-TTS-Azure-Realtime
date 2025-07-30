'use strict';

const getTimestamp = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ` +
           `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}` +
           `.${String(d.getMilliseconds()).padStart(3, '0')}`;
};

const log = (level, ...args) => {
    const message = args.map(arg => {
        if (typeof arg === 'object' && arg !== null) {
            return JSON.stringify(arg, null, 2);
        }
        return arg;
    }).join(' ');

    const formattedMessage = `[${getTimestamp()}] [${level.toUpperCase()}] ${message}`;

    if (level === 'error') {
        console.error(formattedMessage);
    } else {
        console.log(formattedMessage);
    }
};

const logger = {
    info: (...args) => log('info', ...args),
    warn: (...args) => log('warn', ...args),
    error: (...args) => log('error', ...args),
    debug: (...args) => log('debug', ...args),
};

module.exports = logger;
