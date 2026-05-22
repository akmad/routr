import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  formatNotification,
  getPermission,
  isSupported,
  notify,
  requestPermission,
} from './notifications.js';

// vitest/jsdom provides `window.Notification`. We stub specific bits per test
// rather than relying on whatever default state jsdom ships with.

type NotificationCtor = typeof Notification;

function withMockNotification(
  permission: NotificationPermission,
  ctorImpl?: (title: string, opts?: NotificationOptions) => Notification,
) {
  const mock = vi.fn(
    ctorImpl ?? (() => ({ onclick: null, close: vi.fn() }) as unknown as Notification),
  );
  (mock as unknown as { permission: NotificationPermission }).permission = permission;
  (
    mock as unknown as { requestPermission: () => Promise<NotificationPermission> }
  ).requestPermission = vi.fn().mockResolvedValue(permission);
  vi.stubGlobal('Notification', mock as unknown as NotificationCtor);
  return mock;
}

describe('notifications helper', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('formatNotification', () => {
    it('URL items: title names the sender, body is the URL', () => {
      const { title, body } = formatNotification({
        kind: 'url',
        url: 'https://example.com/page',
        fromName: 'Phone',
      });
      expect(title).toBe('Beam — link from Phone');
      expect(body).toBe('https://example.com/page');
    });

    it('file items: title names the sender, body is the filename', () => {
      const { title, body } = formatNotification({
        kind: 'file',
        filename: 'report.pdf',
        fromName: 'Laptop',
      });
      expect(title).toContain('file from Laptop');
      expect(body).toBe('report.pdf');
    });

    it('note items with a title use the title in the heading', () => {
      const { title, body } = formatNotification({
        kind: 'note',
        title: 'Shopping list',
        text: 'milk, eggs',
        fromName: 'Phone',
      });
      expect(title).toBe('Beam — Shopping list');
      expect(body).toBe('milk, eggs');
    });

    it('note items without a title fall back to "note from <sender>"', () => {
      const { title } = formatNotification({
        kind: 'note',
        text: 'hi',
        fromName: 'Phone',
      });
      expect(title).toBe('Beam — note from Phone');
    });

    it('note bodies longer than 200 chars are truncated', () => {
      const long = 'a'.repeat(500);
      const { body } = formatNotification({ kind: 'note', text: long, fromName: 'X' });
      expect(body).toHaveLength(200);
    });
  });

  describe('isSupported / getPermission', () => {
    it('returns "unsupported" when Notification is missing', () => {
      vi.stubGlobal('Notification', undefined);
      expect(isSupported()).toBe(false);
      expect(getPermission()).toBe('unsupported');
    });

    it('forwards the current permission state when supported', () => {
      withMockNotification('granted');
      expect(isSupported()).toBe(true);
      expect(getPermission()).toBe('granted');
    });
  });

  describe('requestPermission', () => {
    it('returns "unsupported" when Notification is missing', async () => {
      vi.stubGlobal('Notification', undefined);
      expect(await requestPermission()).toBe('unsupported');
    });

    it('resolves with the result from Notification.requestPermission', async () => {
      withMockNotification('granted');
      expect(await requestPermission()).toBe('granted');
    });
  });

  describe('notify', () => {
    it('is a no-op when permission is not granted', () => {
      const mock = withMockNotification('default');
      const n = notify({ kind: 'url', url: 'x', fromName: 'Y' });
      expect(n).toBeNull();
      expect(mock).not.toHaveBeenCalled();
    });

    it('constructs a Notification with the formatted title and body', () => {
      const close = vi.fn();
      const ctor = vi.fn(() => ({ onclick: null, close }) as unknown as Notification);
      (ctor as unknown as { permission: NotificationPermission }).permission = 'granted';
      vi.stubGlobal('Notification', ctor as unknown as NotificationCtor);

      notify({ kind: 'url', url: 'https://example.com', fromName: 'Phone' });

      expect(ctor).toHaveBeenCalledTimes(1);
      const [title, options] = ctor.mock.calls[0] as unknown as [string, NotificationOptions];
      expect(title).toBe('Beam — link from Phone');
      expect(options?.body).toBe('https://example.com');
      expect(options?.tag).toBe('beam-inbox'); // collapse rapid pushes to one
    });
  });
});
