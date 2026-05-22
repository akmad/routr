import { pino } from 'pino';
import type { Config } from './config.js';

export type Logger = ReturnType<typeof pino>;

export function createLogger(config: Pick<Config, 'logLevel'>): Logger {
  return pino({
    level: config.logLevel,
    base: { svc: 'routr-server' },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}
