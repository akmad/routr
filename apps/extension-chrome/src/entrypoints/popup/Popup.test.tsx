import { bytesToB64u, generateIdentity } from '@routr/crypto';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type StoredIdentity, clearIdentity, saveIdentity } from '../../lib/keystore.js';
import { browserStubs } from '../../test/setup.js';
import { Popup } from './Popup.js';

const ORIGINAL_FETCH = globalThis.fetch;

function makeIdentity(overrides: Partial<StoredIdentity> = {}): StoredIdentity {
  const id = generateIdentity();
  return {
    deviceId: '01HEXTSELF000000000000000A',
    userId: '01HEXTUSER0000000000000000',
    serverUrl: 'http://test.local',
    signSecretKey: id.sign.secretKey,
    signPublicKey: id.sign.publicKey,
    kexSecretKey: id.kex.secretKey,
    kexPublicKey: id.kex.publicKey,
    ...overrides,
  };
}

function deviceFixture(over: { id: string; name: string }) {
  const id = generateIdentity();
  return {
    id: over.id,
    name: over.name,
    signPub: bytesToB64u(id.sign.publicKey),
    kexPub: bytesToB64u(id.kex.publicKey),
  };
}

beforeEach(async () => {
  await clearIdentity();
});

afterEach(async () => {
  await clearIdentity();
  globalThis.fetch = ORIGINAL_FETCH;
});

// ─── Setup mode (no stored identity) ─────────────────────────────────────────

describe('Popup — setup mode', () => {
  it('shows the setup form when no identity is stored', async () => {
    render(<Popup />);
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /set up beam/i })).toBeInTheDocument(),
    );
    expect(screen.getByLabelText(/server url/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/device name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/invite code/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /register this extension/i })).toBeInTheDocument();
  });

  it('defaults server URL to http://localhost:3000 and device name to Chrome Extension', async () => {
    render(<Popup />);
    await waitFor(() => expect(screen.getByLabelText(/server url/i)).toBeInTheDocument());
    expect((screen.getByLabelText(/server url/i) as HTMLInputElement).value).toBe(
      'http://localhost:3000',
    );
    expect((screen.getByLabelText(/device name/i) as HTMLInputElement).value).toBe(
      'Chrome Extension',
    );
  });

  it('surfaces an error message when registration fails', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: 'invite_required' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
    ) as typeof fetch;

    render(<Popup />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /register this extension/i })).toBeInTheDocument(),
    );
    await userEvent.click(screen.getByRole('button', { name: /register this extension/i }));

    await waitFor(() => expect(screen.getByText(/invite_required|failed/i)).toBeInTheDocument());
  });
});

// ─── Ready mode (identity present) ───────────────────────────────────────────

describe('Popup — ready mode', () => {
  it('shows the send-tab UI with the active tab URL and a recipient dropdown', async () => {
    await saveIdentity(makeIdentity());
    browserStubs.tabsQuery.mockImplementation(async () => [
      { id: 1, url: 'https://example.com/article' },
    ]);
    // /api/v1/devices returns a different device (so others.length > 0).
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify([
          deviceFixture({ id: '01HEXTSELF000000000000000A', name: 'self' }),
          deviceFixture({ id: '01HOTHERPHONE0000000000000', name: 'Phone' }),
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    render(<Popup />);
    await waitFor(() =>
      expect(screen.getByText('https://example.com/article')).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: /send this tab/i })).toBeInTheDocument();
    // The dropdown lists "Send to: Phone" for the non-self device.
    await waitFor(() => expect(screen.getByText(/send to: phone/i)).toBeInTheDocument());
  });

  it('shows "Pair another device first" when no other devices are paired', async () => {
    await saveIdentity(makeIdentity());
    browserStubs.tabsQuery.mockImplementation(async () => [{ id: 1, url: 'https://example.com' }]);
    // Only self in the device list.
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify([deviceFixture({ id: '01HEXTSELF000000000000000A', name: 'self' })]),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    render(<Popup />);
    await waitFor(() => expect(screen.getByText(/pair another device first/i)).toBeInTheDocument());
    // The Send button is disabled when there are no other devices.
    expect(screen.getByRole('button', { name: /send this tab/i })).toBeDisabled();
  });

  it('clicking "Send this tab" dispatches a runtime message to the background script', async () => {
    await saveIdentity(makeIdentity());
    browserStubs.tabsQuery.mockImplementation(async () => [
      { id: 1, url: 'https://example.com/article' },
    ]);
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify([
          deviceFixture({ id: '01HEXTSELF000000000000000A', name: 'self' }),
          deviceFixture({ id: '01HOTHERPHONE0000000000000', name: 'Phone' }),
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    render(<Popup />);
    await waitFor(() => expect(screen.getByText(/send to: phone/i)).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /send this tab/i }));

    await waitFor(() =>
      expect(browserStubs.runtimeSendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'send_url',
          url: 'https://example.com/article',
          recipientId: '01HOTHERPHONE0000000000000',
        }),
      ),
    );
    await waitFor(() => expect(screen.getByText('Sent!')).toBeInTheDocument());
  });

  it('shows an error message when the background script reports a failure', async () => {
    await saveIdentity(makeIdentity());
    browserStubs.tabsQuery.mockImplementation(async () => [{ id: 1, url: 'https://example.com' }]);
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify([
          deviceFixture({ id: '01HEXTSELF000000000000000A', name: 'self' }),
          deviceFixture({ id: '01HOTHERPHONE0000000000000', name: 'Phone' }),
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    browserStubs.runtimeSendMessage.mockImplementation(async () => ({
      ok: false,
      error: 'network error',
    }));

    render(<Popup />);
    await waitFor(() => expect(screen.getByText(/send to: phone/i)).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /send this tab/i }));

    await waitFor(() => expect(screen.getByText(/network error/i)).toBeInTheDocument());
  });

  it('expanding the Fingerprints section shows the device fingerprints', async () => {
    await saveIdentity(makeIdentity());
    browserStubs.tabsQuery.mockImplementation(async () => [{ id: 1, url: 'https://example.com' }]);
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify([
          deviceFixture({ id: '01HEXTSELF000000000000000A', name: 'self' }),
          deviceFixture({ id: '01HOTHERPHONE0000000000000', name: 'Phone' }),
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    render(<Popup />);
    await waitFor(() => expect(screen.getByText(/send to: phone/i)).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /fingerprints/i }));

    // After expand: a <p> label "This device" appears next to the own fingerprint.
    // The "Forget this device" button also matches /this device/, so disambiguate
    // by element type — the label is a <p>, the button is a <button>.
    const labels = screen
      .getAllByText(/this device/i)
      .filter((el) => el.tagName.toLowerCase() === 'p');
    expect(labels).toHaveLength(1);
  });

  it('clicking Forget this device clears the identity and returns to setup mode', async () => {
    await saveIdentity(makeIdentity());
    browserStubs.tabsQuery.mockImplementation(async () => [{ id: 1, url: 'https://example.com' }]);
    globalThis.fetch = vi.fn(async () => {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    render(<Popup />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /forget this device/i })).toBeInTheDocument(),
    );
    await userEvent.click(screen.getByRole('button', { name: /forget this device/i }));

    // After Forget: setup heading reappears.
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /set up beam/i })).toBeInTheDocument(),
    );
  });
});
