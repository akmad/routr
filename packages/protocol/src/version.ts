/**
 * Protocol version. Incremented on any breaking wire-format change.
 *
 * Format: integer. Clients refuse to communicate with peers on a different
 * major version. Minor compatibility is handled by individual schemas.
 */
export const PROTOCOL_VERSION = 1;
