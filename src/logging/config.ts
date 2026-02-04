import pino from 'pino';

export type LoggingConfig = {
  level: pino.Level;
  destination: 'stdout' | string;
};

const VALID_LEVELS: pino.Level[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];

function resolveLogLevel(): pino.Level {
  const level = process.env.LOG_LEVEL?.toLowerCase();

  if (level && (VALID_LEVELS as readonly string[]).includes(level)) {
    return level as pino.Level;
  }

  return process.env.NODE_ENV === 'test' ? 'warn' : 'info';
}

function resolveDestination(): 'stdout' | string {
  const destination = process.env.LOG_DESTINATION?.trim();
  if (!destination || destination === 'stdout') {
    return 'stdout';
  }

  if (destination === 'stderr') {
    return 'stderr';
  }

  return destination;
}

export function getLoggingConfig(): LoggingConfig {
  const format = process.env.LOG_FORMAT?.trim();
  if (format && format.toLowerCase() !== 'json') {
    throw new Error('LOG_FORMAT must be "json" to match the unified logging pipeline.');
  }

  const level = resolveLogLevel();
  const destination = resolveDestination();

  return {
    level,
    destination,
  };
}
