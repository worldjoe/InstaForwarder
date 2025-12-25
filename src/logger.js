const winston = require('winston');
const path = require('path');

// Define log levels
const levels = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4
};

// Define colors for each level
const colors = {
  error: 'red',
  warn: 'yellow',
  info: 'green',
  debug: 'blue',
  trace: 'magenta'
};

winston.addColors(colors);

// Create the logger
const logger = winston.createLogger({
  levels,
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    winston.format.json()
  ),
  transports: [
    // Write all logs to console
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize({ all: true }),
        winston.format.printf(({ timestamp, level, message, ...rest }) => {
          let log = `${timestamp} [${level}]: ${message}`;
          // Add extra data if present
          const extras = Object.keys(rest).filter(k => k !== 'timestamp' && k !== 'level' && k !== 'message');
          if (extras.length > 0) {
            const extraData = {};
            extras.forEach(k => extraData[k] = rest[k]);
            log += ` ${JSON.stringify(extraData)}`;
          }
          return log;
        })
      )
    }),
    // Write errors to error.log
    new winston.transports.File({ 
      filename: path.join(process.cwd(), 'logs', 'error.log'), 
      level: 'error',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
      )
    }),
    // Write all logs to combined.log
    new winston.transports.File({ 
      filename: path.join(process.cwd(), 'logs', 'combined.log'),
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
      )
    })
  ]
});

module.exports = logger;
