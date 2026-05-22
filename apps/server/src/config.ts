import * as v from 'valibot';

// Positive byte-size from an env string. Accepts plain ints in bytes —
// callers can pass "26214400" (25 MiB) etc.
const positiveBytesFromString = (defaultValue: string) =>
  v.pipe(
    v.optional(v.string(), defaultValue),
    v.transform((s) => Number.parseInt(s, 10)),
    v.integer('must be an integer number of bytes'),
    v.minValue(1, 'must be positive'),
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
  // Per-upload size caps. The 25 MiB blob default matches the MVP value;
  // envelopes (small ciphertext bodies) default to 1 MiB. Self-hosters
  // with disk constraints can lower these; deploys with bigger needs can
  // raise them.
  maxBlobBytes: positiveBytesFromString(String(25 * 1024 * 1024)),
  maxEnvelopeBytes: positiveBytesFromString(String(1 * 1024 * 1024)),
});

export type Config = v.InferOutput<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return v.parse(ConfigSchema, {
    port: env.PORT,
    host: env.HOST,
    databaseUrl: env.DATABASE_URL,
    blobStorageDir: env.BLOB_STORAGE_DIR,
    logLevel: env.LOG_LEVEL,
    maxBlobBytes: env.MAX_BLOB_BYTES,
    maxEnvelopeBytes: env.MAX_ENVELOPE_BYTES,
  });
}
