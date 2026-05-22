// Browser desktop notifications for incoming envelopes.
//
// Permission is requested only when the user explicitly clicks the
// "Enable notifications" banner — we never auto-prompt, since browsers
// punish that with permanent denial. The user's prior choice is read
// straight from the `Notification.permission` API; we don't shadow it
// with localStorage.

export type NotificationItem =
  | { kind: 'url'; url: string; fromName: string }
  | { kind: 'file'; filename: string; fromName: string }
  | { kind: 'note'; title?: string; text: string; fromName: string };

export function isSupported(): boolean {
  return typeof Notification !== 'undefined';
}

export function getPermission(): NotificationPermission | 'unsupported' {
  if (!isSupported()) return 'unsupported';
  return Notification.permission;
}

export async function requestPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (!isSupported()) return 'unsupported';
  try {
    return await Notification.requestPermission();
  } catch {
    // Some sandboxed contexts throw on requestPermission — treat as denied.
    return 'denied';
  }
}

/**
 * Build the (title, body) pair the OS will display.
 * Exported separately from `notify` so tests can assert on the formatting
 * without needing to mock the Notification constructor.
 */
export function formatNotification(item: NotificationItem): { title: string; body: string } {
  if (item.kind === 'url') {
    return { title: `Beam — link from ${item.fromName}`, body: item.url };
  }
  if (item.kind === 'file') {
    return { title: `Beam — file from ${item.fromName}`, body: item.filename };
  }
  // note
  const title = item.title ? `Beam — ${item.title}` : `Beam — note from ${item.fromName}`;
  return { title, body: item.text.slice(0, 200) };
}

/**
 * Fire a desktop notification. Caller is responsible for permission /
 * page-visibility gating. Returns the Notification instance (or null if
 * unsupported/denied) so callers can wire onClick.
 */
export function notify(item: NotificationItem): Notification | null {
  if (!isSupported() || Notification.permission !== 'granted') return null;
  const { title, body } = formatNotification(item);
  try {
    const n = new Notification(title, { body, tag: 'beam-inbox' });
    n.onclick = () => {
      if (typeof window !== 'undefined') window.focus();
      n.close();
    };
    return n;
  } catch {
    return null;
  }
}
