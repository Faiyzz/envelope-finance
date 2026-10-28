/**
 * Logging with pino and redaction - TD-00 §8
 * 
 * Redacts sensitive fields: amount*, note, name, owner_name, email, password*, token*, authorization, cookie.
 */

import pino from 'pino';

const redactPaths = [
  'amount*',
  'note',
  'name',
  'owner_name',
  'email',
  'password*',
  'token*',
  'authorization',
  'cookie',
];

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  redact: redactPaths,
  formatters: {
    level: (label: string) => {
      return { level: label };
    },
  },
  serializers: {
    error: pino.stdSerializers.err,
  },
});

export default logger;
