/**
 * Human-readable byte count: "500 B", "12 KB", "3.4 MB", "1.5 GB".
 * Duplicated from apps/web/src/lib/format.ts — web and extension don't
 * share a runtime helper module.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
