/**
 * Minimal logger. Human-readable on a terminal, JSON if LOG_FORMAT=json.
 */

const levels = { debug: 10, info: 20, warn: 30, error: 40 };
const currentLevel = levels[process.env.LOG_LEVEL?.toLowerCase()] || levels.info;
const jsonFormat = process.env.LOG_FORMAT === 'json';

const colors = {
  debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m',
  error: '\x1b[31m', reset: '\x1b[0m',
};

function log(level, dataOrMsg, maybeMsg) {
  if (levels[level] < currentLevel) return;

  const data = typeof dataOrMsg === 'object' ? dataOrMsg : {};
  const msg = typeof dataOrMsg === 'string' ? dataOrMsg : maybeMsg || '';

  if (jsonFormat) {
    console[level === 'error' ? 'error' : 'log'](JSON.stringify({
      level, ts: new Date().toISOString(), msg, ...data,
    }));
    return;
  }

  const time = new Date().toTimeString().slice(0, 8);
  const c = colors[level];
  const details = Object.keys(data).length
    ? ' ' + Object.entries(data).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' ')
    : '';
  console[level === 'error' ? 'error' : 'log'](
    `${colors.debug}${time}${colors.reset} ${c}${level.toUpperCase().padEnd(5)}${colors.reset} ${msg}${details}`
  );
}

export const logger = {
  debug: (d, m) => log('debug', d, m),
  info:  (d, m) => log('info', d, m),
  warn:  (d, m) => log('warn', d, m),
  error: (d, m) => log('error', d, m),
};
