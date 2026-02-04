import pino from 'pino';
import SonicBoom from 'sonic-boom';
import { getLoggingConfig, LoggingConfig } from './config.js';

export type LoggerBundle = {
  logger: pino.Logger;
  flush: () => Promise<void>;
  destination: SonicBoom;
};

function createDestination(destination: LoggingConfig['destination']): SonicBoom {
  if (destination === 'stdout') {
    return pino.destination({ dest: 1, sync: false });
  }

  if (destination === 'stderr') {
    return pino.destination({ dest: 2, sync: false });
  }

  return pino.destination({
    dest: destination,
    append: true,
    sync: false,
  });
}

function flushDestination(destination: SonicBoom): Promise<void> {
  if (typeof destination.flushSync === 'function') {
    destination.flushSync();
    return Promise.resolve();
  }

  if (typeof destination.flush === 'function') {
    return new Promise<void>((resolve, reject) => {
      destination.flush((err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  return Promise.resolve();
}

export function buildLogger(config: LoggingConfig = getLoggingConfig()): LoggerBundle {
  const forceStderr = process.env.FORCE_STDERR === 'true';
  const destinationTarget = forceStderr ? 'stderr' : config.destination;
  const destination = createDestination(destinationTarget);
  const logger = pino(
    {
      level: config.level,
      formatters: {
        level: (label) => ({ level: label }),
      },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    destination,
  );

  return {
    logger,
    destination,
    flush: () => flushDestination(destination),
  };
}
