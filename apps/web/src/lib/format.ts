/**
 * Human-readable byte count: "500 B", "12 KB", "3.4 MB", "1.5 GB".
 * KB resolution is whole-number (sub-KB display is one tap on the file
 * itself away); MB and GB get one decimal so a 1.2 MB file doesn't read
 * the same as a 1.9 MB one.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
