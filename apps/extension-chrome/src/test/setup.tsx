import '@testing-library/jest-dom/vitest';
import 'fake-indexeddb/auto';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// Stub the WebExtension `browser` global. In real builds WXT polyfills
// this via webextension-polyfill; under vitest/jsdom there's no extension
// runtime, so component tests get a minimal stub keyed by what the popup
// + options pages actually touch (tabs, runtime, contextMenus,
// notifications, commands, action).
//
// Tests can override individual methods via vi.spyOn before rendering.

type AnyFn = (...args: unknown[]) => unknown;

function listener<T extends AnyFn>() {
  const listeners = new Set<T>();
  return {
    addListener: (fn: T) => listeners.add(fn),
    removeListener: (fn: T) => listeners.delete(fn),
    hasListener: (fn: T) => listeners.has(fn),
    _emit: (...args: Parameters<T>) => {
      for (const fn of listeners) {
        (fn as (...a: Parameters<T>) => unknown)(...args);
      }
    },
  };
}

// Module-level vi.fn() handles so tests can `vi.mocked(...).mockResolvedValue(...)`.
export const browserStubs = {
  tabsQuery: vi.fn(async () => [] as Array<{ id?: number; url?: string }>),
  runtimeSendMessage: vi.fn(async (_msg: unknown) => ({ ok: true })),
  notificationsCreate: vi.fn(async (_opts: unknown) => 'notification-id'),
  contextMenusCreate: vi.fn(),
  actionOpenPopup: vi.fn(async () => undefined),
};

const browserStub = {
  tabs: { query: browserStubs.tabsQuery },
  runtime: {
    sendMessage: browserStubs.runtimeSendMessage,
    onMessage: listener<AnyFn>(),
    onInstalled: listener<AnyFn>(),
    getBrowserInfo: undefined as undefined | (() => Promise<unknown>),
  },
  notifications: { create: browserStubs.notificationsCreate },
  contextMenus: { create: browserStubs.contextMenusCreate, onClicked: listener<AnyFn>() },
  commands: { onCommand: listener<AnyFn>() },
  action: { openPopup: browserStubs.actionOpenPopup, onClicked: listener<AnyFn>() },
  storage: { local: { get: vi.fn(), set: vi.fn() } },
};

// Expose on both `globalThis.browser` and `globalThis.chrome` so any code
// path that reaches for either picks up the same stub.
vi.stubGlobal('browser', browserStub);
vi.stubGlobal('chrome', browserStub);

// Reset RTL between tests; also reset stub call history so each test
// starts from a clean slate.
afterEach(() => {
  cleanup();
  for (const fn of Object.values(browserStubs)) {
    fn.mockClear();
  }
  // Restore default tabsQuery behavior (returns empty array). Tests that
  // overrode it can rely on this reset.
  browserStubs.tabsQuery.mockImplementation(async () => []);
  browserStubs.runtimeSendMessage.mockImplementation(async () => ({ ok: true }));
});
