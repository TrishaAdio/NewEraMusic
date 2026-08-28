import pino from 'pino';

/**
 * Structured JSON logs in production, human-readable in development.
 *
 * Bot tokens and session strings are redacted at the serialiser level rather
 * than by remembering not to log them. A leaked TG_SESSION is full account
 * access, so this is worth enforcing centrally.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: {
    paths: [
      'BOT_TOKEN',
      'TG_SESSION',
      'TG_API_HASH',
      'SPOTIFY_CLIENT_SECRET',
      '*.token',
      '*.session',
      'req.headers.authorization',
    ],
    censor: '[redacted]',
  },
  ...(process.env.NODE_ENV === 'production'
    ? {}
    : { transport: { target: 'pino-pretty', options: { colorize: true } } }),
});

export function childLogger(bindings: Record<string, unknown>) {
  return logger.child(bindings);
}
