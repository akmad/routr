import * as v from 'valibot';

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
});

export type Config = v.InferOutput<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return v.parse(ConfigSchema, {
    port: env.PORT,
    host: env.HOST,
    databaseUrl: env.DATABASE_URL,
    blobStorageDir: env.BLOB_STORAGE_DIR,
    logLevel: env.LOG_LEVEL,
  });
}
