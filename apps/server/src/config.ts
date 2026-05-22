import * as v from 'valibot';

// Token-bucket parameters: capacity is the burst ceiling, refillPerSecond
// is the steady-state rate. Both are positive numbers; refillPerSecond
// can be fractional (e.g. 0.2 = one token every 5 seconds).
const positiveNumberFromString = (defaultValue: string) =>
  v.pipe(
    v.optional(v.string(), defaultValue),
    v.transform((s) => Number.parseFloat(s)),
    v.number(),
    v.minValue(0, 'must be positive'),
  );

const positiveIntFromString = (defaultValue: string) =>
  v.pipe(
    v.optional(v.string(), defaultValue),
    v.transform((s) => Number.parseInt(s, 10)),
    v.integer(),
    v.minValue(1),
  );

const ConfigSchema = v.object({
  port: v.pipe(
    v.optional(v.string(), '8080'),
    v.transform((s) => Number.parseInt(s, 10)),
    v.integer(),
    v.minValue(1),
    v.maxValue(65535),
  ),
  host: v.optional(v.string(), '0.0.0.0'),
  databaseUrl: v.optional(v.string(), 'data/routr.db'),
  blobStorageDir: v.optional(v.string(), 'data/blobs'),
  logLevel: v.optional(v.picklist(['trace', 'debug', 'info', 'warn', 'error', 'fatal']), 'info'),
  // Per-IP token-bucket limits. Defaults preserve the previous hardcoded
  // values so existing deploys see no behavioral change.
  rateLimitDevicesCapacity: positiveIntFromString('10'),
  rateLimitDevicesRefillPerSecond: positiveNumberFromString('0.2'),
  rateLimitEnvelopesCapacity: positiveIntFromString('60'),
  rateLimitEnvelopesRefillPerSecond: positiveNumberFromString('1'),
});

export type Config = v.InferOutput<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return v.parse(ConfigSchema, {
    port: env.PORT,
    host: env.HOST,
    databaseUrl: env.DATABASE_URL,
    blobStorageDir: env.BLOB_STORAGE_DIR,
    logLevel: env.LOG_LEVEL,
    rateLimitDevicesCapacity: env.RATE_LIMIT_DEVICES_CAPACITY,
    rateLimitDevicesRefillPerSecond: env.RATE_LIMIT_DEVICES_REFILL_PER_SECOND,
    rateLimitEnvelopesCapacity: env.RATE_LIMIT_ENVELOPES_CAPACITY,
    rateLimitEnvelopesRefillPerSecond: env.RATE_LIMIT_ENVELOPES_REFILL_PER_SECOND,
  });
}
