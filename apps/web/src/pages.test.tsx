import { bytesToB64u, generateIdentity } from '@routr/crypto';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearIdentity, saveIdentity } from './lib/keystore.js';
import { deleteRule, listRules, newRuleId, saveRule } from './lib/rules.js';
import { clearSent, recordSend } from './lib/sent.js';
import {
  DevicesPage,
  InboxPage,
  NotFoundPage,
  RulesPage,
  SendPage,
  SentPage,
  SettingsPage,
  SetupPage,
} from './router.js';
import { makeIdentity, renderWithIdentity } from './test/utils.js';

async function clearRules(): Promise<void> {
  const all = await listRules();
  for (const r of all) await deleteRule(r.id);
}

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_LOCATION = window.location;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.spyOn(window, 'alert').mockImplementation(() => {});
});

afterEach(async () => {
  await clearSent();
  await clearIdentity();
  await clearRules();
  globalThis.fetch = ORIGINAL_FETCH;
  Object.defineProperty(window, 'location', { value: ORIGINAL_LOCATION, configurable: true });
});

// ─── Test helpers ────────────────────────────────────────────────────────────

function stubLocation() {
  const stub = { href: '/', replace: vi.fn(), pathname: '/', origin: 'http://test.local' };
  Object.defineProperty(window, 'location', { value: stub, writable: true, configurable: true });
  return stub;
}

function mockFetchJson(handler: (url: string, init?: RequestInit) => unknown): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const body = handler(url, init);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

// Server-shaped device record. Uses real key bytes so fingerprint() succeeds.
function deviceRecord(overrides: { id: string; name: string; platform?: string }) {
  const id = generateIdentity();
  return {
    id: overrides.id,
    name: overrides.name,
    platform: overrides.platform ?? 'web',
    kexPub: bytesToB64u(id.kex.publicKey),
    signPub: bytesToB64u(id.sign.publicKey),
    lastSeenAt: Date.now(),
    createdAt: Date.now(),
  };
}

// ─── NotFoundPage ────────────────────────────────────────────────────────────

describe('NotFoundPage', () => {
  it('renders the not-found message and a link back to the inbox', () => {
    renderWithIdentity(<NotFoundPage />);
    expect(screen.getByText(/nothing here/i)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /back to inbox/i });
    expect(link).toHaveAttribute('href', '/inbox');
  });
});

// ─── SettingsPage ────────────────────────────────────────────────────────────

describe('SettingsPage', () => {
  it('displays the active identity (server, device id, user id)', () => {
    const id = makeIdentity({
      serverUrl: 'https://beam.example',
      deviceId: '01HDEVICE0000000000000000A',
      userId: '01HUSER000000000000000000A',
    });
    renderWithIdentity(<SettingsPage />, id);
    expect(screen.getByText('https://beam.example')).toBeInTheDocument();
    expect(screen.getByText('01HDEVICE0000000000000000A')).toBeInTheDocument();
    expect(screen.getByText('01HUSER000000000000000000A')).toBeInTheDocument();
  });

  it('renders a fingerprint derived from the public keys', () => {
    renderWithIdentity(<SettingsPage />);
    const fpLabel = screen.getByText('Fingerprint');
    const fpEl = fpLabel.nextElementSibling;
    expect(fpEl?.textContent).toMatch(/\S/);
    expect(fpEl?.textContent).not.toBe('—');
  });

  it('shows an em-dash placeholder when the identity has malformed keys', () => {
    const id = makeIdentity({ signPublicKey: new Uint8Array(0), kexPublicKey: new Uint8Array(0) });
    renderWithIdentity(<SettingsPage />, id);
    const fpLabel = screen.getByText('Fingerprint');
    expect(fpLabel.nextElementSibling?.textContent).toBe('—');
  });

  it('forget-this-device clears storage and redirects to /setup', async () => {
    const id = makeIdentity();
    await saveIdentity(id);
    const loc = stubLocation();
    renderWithIdentity(<SettingsPage />, id);

    await userEvent.click(screen.getByRole('button', { name: /forget this device/i }));

    await waitFor(() => expect(loc.href).toBe('/setup'));
    expect(window.confirm).toHaveBeenCalled();
  });

  it('does not redirect if the user cancels the confirm', async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    const id = makeIdentity();
    await saveIdentity(id);
    const loc = stubLocation();
    renderWithIdentity(<SettingsPage />, id);

    await userEvent.click(screen.getByRole('button', { name: /forget this device/i }));

    // No navigation happened.
    expect(loc.href).toBe('/');
  });
});

// ─── SentPage ────────────────────────────────────────────────────────────────

describe('SentPage', () => {
  beforeEach(() => {
    mockFetchJson(() => []);
  });

  it('shows the empty state when nothing has been sent', async () => {
    renderWithIdentity(<SentPage />);
    await waitFor(() => expect(screen.getByText(/nothing sent yet/i)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /clear all/i })).not.toBeInTheDocument();
  });

  it('renders sent items with summary, kind icon, and resolved recipient device names', async () => {
    await recordSend({
      kind: 'url',
      summary: 'https://example.com/article',
      recipientIds: ['01HDEVICE000000000000000RC'],
    });
    await recordSend({
      kind: 'note',
      summary: 'remember to call mom',
      recipientIds: ['01HDEVICE000000000000000RC'],
    });
    await recordSend({
      kind: 'file',
      summary: 'beach.jpg (2 MB)',
      recipientIds: ['01HDEVICE000000000000000RC'],
    });

    mockFetchJson(() => [
      deviceRecord({ id: '01HDEVICE000000000000000RC', name: 'Phone', platform: 'android' }),
    ]);

    renderWithIdentity(<SentPage />);

    await waitFor(() => expect(screen.getByText(/example\.com\/article/)).toBeInTheDocument());
    expect(screen.getByText(/remember to call mom/)).toBeInTheDocument();
    expect(screen.getByText(/beach\.jpg/)).toBeInTheDocument();
    expect(screen.getByText(/📝/)).toBeInTheDocument();
    expect(screen.getByText(/📎/)).toBeInTheDocument();
    // After devices load, device name resolves to "Phone".
    await waitFor(() => expect(screen.getAllByText(/to Phone/).length).toBeGreaterThan(0));
  });

  it('falls back to a truncated device id when the device list lookup misses', async () => {
    await recordSend({
      kind: 'note',
      summary: 'hello',
      recipientIds: ['01HUNKNOWNDEVICEID12345678'],
    });
    mockFetchJson(() => []);

    renderWithIdentity(<SentPage />);
    await waitFor(() => expect(screen.getByText(/hello/)).toBeInTheDocument());
    // First 8 chars of the device id with an ellipsis (no trailing space; "&middot;" follows).
    expect(screen.getByText(/01HUNKNO…/)).toBeInTheDocument();
  });

  it('clear-all empties the list when confirmed', async () => {
    await recordSend({
      kind: 'note',
      summary: 'goodbye',
      recipientIds: ['01HDEVICE000000000000000RC'],
    });
    renderWithIdentity(<SentPage />);
    await waitFor(() => expect(screen.getByText(/goodbye/)).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /clear all/i }));

    await waitFor(() => expect(screen.getByText(/nothing sent yet/i)).toBeInTheDocument());
  });
});

// ─── SetupPage ────────────────────────────────────────────────────────────────

describe('SetupPage', () => {
  it('renders the setup form: server URL, device name, invite, create button', () => {
    stubLocation();
    renderWithIdentity(<SetupPage />);
    expect(screen.getByLabelText(/server url/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/device name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/invite code/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create device/i })).toBeInTheDocument();
  });

  it('defaults the server URL to the current origin', () => {
    const loc = stubLocation();
    loc.origin = 'http://test.local';
    renderWithIdentity(<SetupPage />);
    const serverInput = screen.getByLabelText(/server url/i) as HTMLInputElement;
    expect(serverInput.value).toBe('http://test.local');
  });

  it('defaults the device name to "My Browser"', () => {
    stubLocation();
    renderWithIdentity(<SetupPage />);
    const nameInput = screen.getByLabelText(/device name/i) as HTMLInputElement;
    expect(nameInput.value).toBe('My Browser');
  });

  it('surfaces an error when the server probe fails', async () => {
    stubLocation();
    globalThis.fetch = vi.fn(async () => new Response('', { status: 500 })) as typeof fetch;
    renderWithIdentity(<SetupPage />);

    await userEvent.click(screen.getByRole('button', { name: /create device/i }));

    await waitFor(() => expect(screen.getByText(/can't reach server/i)).toBeInTheDocument());
  });
});

// ─── SendPage ────────────────────────────────────────────────────────────────

describe('SendPage', () => {
  it('renders three send-mode buttons: URL, File, Note', async () => {
    mockFetchJson(() => []);
    renderWithIdentity(<SendPage />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'URL' })).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'File' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Note' })).toBeInTheDocument();
  });

  it('URL mode is active by default (shows the URL input)', async () => {
    mockFetchJson(() => []);
    renderWithIdentity(<SendPage />);
    await waitFor(() => expect(screen.getByLabelText('URL')).toBeInTheDocument());
    expect(screen.getByPlaceholderText(/https:\/\//)).toBeInTheDocument();
  });

  it('switches to Note mode when the Note button is clicked', async () => {
    mockFetchJson(() => []);
    renderWithIdentity(<SendPage />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Note' })).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: 'Note' }));

    expect(screen.getByLabelText(/^note$/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/^url$/i)).not.toBeInTheDocument();
  });

  it('switches to File mode when the File button is clicked', async () => {
    mockFetchJson(() => []);
    renderWithIdentity(<SendPage />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'File' })).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: 'File' }));

    expect(screen.getByLabelText(/^file$/i)).toBeInTheDocument();
  });

  it('shows a "no other devices" hint when the device list excludes only self', async () => {
    const id = makeIdentity({ deviceId: '01HSELFDEVICE0000000000000' });
    mockFetchJson(() => [deviceRecord({ id: '01HSELFDEVICE0000000000000', name: 'Laptop' })]);
    renderWithIdentity(<SendPage />, id);
    await waitFor(() => expect(screen.getByText(/no other devices found/i)).toBeInTheDocument());
  });

  it('renders a recipient dropdown when other devices exist', async () => {
    const id = makeIdentity({ deviceId: '01HSELFDEVICE0000000000000' });
    mockFetchJson(() => [
      deviceRecord({ id: '01HSELFDEVICE0000000000000', name: 'Laptop' }),
      deviceRecord({ id: '01HOTHERDEVICE000000000000', name: 'Phone', platform: 'android' }),
    ]);
    renderWithIdentity(<SendPage />, id);
    await waitFor(() => expect(screen.getByLabelText(/send to/i)).toBeInTheDocument());
    const select = screen.getByLabelText(/send to/i) as HTMLSelectElement;
    // Default option ("All my other devices") plus one for the Phone device.
    expect(select.options).toHaveLength(2);
    expect(select.options[1]?.text).toBe('Phone');
  });
});

// ─── DevicesPage ──────────────────────────────────────────────────────────────

describe('DevicesPage', () => {
  it('renders one row per device returned by the server', async () => {
    const id = makeIdentity({ deviceId: '01HSELFDEVICE0000000000000' });
    mockFetchJson(() => [
      deviceRecord({ id: '01HSELFDEVICE0000000000000', name: 'Laptop' }),
      deviceRecord({ id: '01HOTHERDEVICE000000000000', name: 'Phone', platform: 'android' }),
    ]);

    renderWithIdentity(<DevicesPage />, id);

    await waitFor(() => expect(screen.getByText('Laptop')).toBeInTheDocument());
    expect(screen.getByText('Phone')).toBeInTheDocument();
    expect(screen.getByText(/\(this device\)/i)).toBeInTheDocument();
  });

  it('shows a revoke button only on non-self devices', async () => {
    const id = makeIdentity({ deviceId: '01HSELFDEVICE0000000000000' });
    mockFetchJson(() => [
      deviceRecord({ id: '01HSELFDEVICE0000000000000', name: 'Laptop' }),
      deviceRecord({ id: '01HOTHERDEVICE000000000000', name: 'Phone' }),
    ]);

    renderWithIdentity(<DevicesPage />, id);

    await waitFor(() => expect(screen.getByText('Phone')).toBeInTheDocument());
    const revokeButtons = screen.getAllByRole('button', { name: /revoke/i });
    expect(revokeButtons).toHaveLength(1);
    // The revoke button belongs to the non-self device row.
    const phoneRow = screen.getByText('Phone').closest('li');
    expect(phoneRow).toBeTruthy();
    if (phoneRow) {
      expect(
        within(phoneRow as HTMLElement).getByRole('button', { name: /revoke/i }),
      ).toBeInTheDocument();
    }
  });

  it('removes a revoked device from the list on successful DELETE', async () => {
    const id = makeIdentity({ deviceId: '01HSELFDEVICE0000000000000' });
    let getCallCount = 0;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      if (url.includes('/api/v1/devices') && method === 'GET') {
        getCallCount++;
        return new Response(
          JSON.stringify([
            deviceRecord({ id: '01HSELFDEVICE0000000000000', name: 'Laptop' }),
            deviceRecord({ id: '01HOTHERDEVICE000000000000', name: 'Phone' }),
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (method === 'DELETE') {
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    renderWithIdentity(<DevicesPage />, id);

    await waitFor(() => expect(screen.getByText('Phone')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /revoke/i }));

    await waitFor(() => expect(screen.queryByText('Phone')).not.toBeInTheDocument());
    expect(getCallCount).toBeGreaterThan(0);
  });

  it('shows an error message when revoke returns a non-OK status', async () => {
    const id = makeIdentity({ deviceId: '01HSELFDEVICE0000000000000' });
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      if (url.includes('/api/v1/devices') && method === 'GET') {
        return new Response(
          JSON.stringify([
            deviceRecord({ id: '01HSELFDEVICE0000000000000', name: 'Laptop' }),
            deviceRecord({ id: '01HOTHERDEVICE000000000000', name: 'Phone' }),
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (method === 'DELETE') {
        return new Response(JSON.stringify({ error: 'not_allowed' }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    renderWithIdentity(<DevicesPage />, id);

    await waitFor(() => expect(screen.getByText('Phone')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /revoke/i }));

    await waitFor(() =>
      expect(screen.getByText(/revoke failed: not_allowed/i)).toBeInTheDocument(),
    );
    // Phone is still in the list — revoke didn't succeed.
    expect(screen.getByText('Phone')).toBeInTheDocument();
  });
});

// ─── RulesPage ───────────────────────────────────────────────────────────────

describe('RulesPage', () => {
  beforeEach(() => {
    mockFetchJson(() => []);
  });

  it('renders the empty state when no rules exist', async () => {
    renderWithIdentity(<RulesPage />);
    await waitFor(() => expect(screen.getByText(/no rules yet\./i)).toBeInTheDocument());
  });

  it('renders the add-rule form (name, pattern type, value, target device, submit)', async () => {
    renderWithIdentity(<RulesPage />);
    await waitFor(() => expect(screen.getByLabelText(/^name$/i)).toBeInTheDocument());
    expect(screen.getByLabelText(/^pattern$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^value$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/send to/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add rule/i })).toBeInTheDocument();
  });

  it('lists existing rules with their pattern and target', async () => {
    const id = makeIdentity();
    await saveRule({
      id: newRuleId(),
      name: 'YouTube to phone',
      pattern: { type: 'url_contains', value: 'youtube.com' },
      targetDeviceId: '01HDEVICE0000000PHONE0000A',
      priority: 0,
    });
    mockFetchJson(() => [deviceRecord({ id: '01HDEVICE0000000PHONE0000A', name: 'Phone' })]);

    renderWithIdentity(<RulesPage />, id);

    await waitFor(() => expect(screen.getByText(/youtube to phone/i)).toBeInTheDocument());
    expect(screen.getByText(/URL contains "youtube\.com"/i)).toBeInTheDocument();
    // Once the device list loads, the target resolves to the device name.
    await waitFor(() => expect(screen.getByText(/→ Phone/i)).toBeInTheDocument());
  });

  it('deletes a rule when its Delete button is clicked', async () => {
    const id = makeIdentity();
    await saveRule({
      id: newRuleId(),
      name: 'YouTube to phone',
      pattern: { type: 'url_contains', value: 'youtube.com' },
      targetDeviceId: '01HDEVICE0000000PHONE0000A',
      priority: 0,
    });

    renderWithIdentity(<RulesPage />, id);

    await waitFor(() => expect(screen.getByText(/youtube to phone/i)).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /^delete$/i }));

    await waitFor(() => expect(screen.queryByText(/youtube to phone/i)).not.toBeInTheDocument());
    expect(screen.getByText(/no rules yet\./i)).toBeInTheDocument();
  });
});

// ─── InboxPage (smoke) ───────────────────────────────────────────────────────

describe('InboxPage (smoke)', () => {
  beforeEach(() => {
    mockFetchJson(() => []);
    class StubWebSocket {
      onopen?: () => void;
      onmessage?: (ev: MessageEvent) => void;
      onclose?: () => void;
      onerror?: () => void;
      readyState = 0;
      send = vi.fn();
      close = vi.fn();
    }
    vi.stubGlobal('WebSocket', StubWebSocket);
  });

  it('renders the Inbox heading and "Connecting…" indicator when no items', async () => {
    renderWithIdentity(<InboxPage />);
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /inbox/i })).toBeInTheDocument(),
    );
    expect(screen.getByText(/no messages yet/i)).toBeInTheDocument();
    expect(screen.getByText(/connecting…/i)).toBeInTheDocument();
  });
});
