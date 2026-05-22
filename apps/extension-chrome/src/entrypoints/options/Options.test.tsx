import { bytesToB64u, generateIdentity } from '@routr/crypto';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type StoredIdentity, clearIdentity, saveIdentity } from '../../lib/keystore.js';
import { deleteRule, listRules, newRuleId, saveRule } from '../../lib/rules.js';
import { clearSent, recordSend } from '../../lib/sent.js';
import { Options } from './Options.js';

const ORIGINAL_FETCH = globalThis.fetch;

function makeIdentity(): StoredIdentity {
  const id = generateIdentity();
  return {
    deviceId: '01HEXTSELF000000000000000A',
    userId: '01HEXTUSER0000000000000000',
    serverUrl: 'http://test.local',
    signSecretKey: id.sign.secretKey,
    signPublicKey: id.sign.publicKey,
    kexSecretKey: id.kex.secretKey,
    kexPublicKey: id.kex.publicKey,
  };
}

async function clearAllRules(): Promise<void> {
  const all = await listRules();
  for (const r of all) await deleteRule(r.id);
}

beforeEach(async () => {
  await clearIdentity();
  await clearSent();
  await clearAllRules();
  // Default: empty device list.
  globalThis.fetch = vi.fn(
    async () =>
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  ) as typeof fetch;
});

afterEach(async () => {
  await clearIdentity();
  await clearSent();
  await clearAllRules();
  globalThis.fetch = ORIGINAL_FETCH;
});

describe('Options — no identity', () => {
  it('shows a hint to set up via the popup when no identity is stored', async () => {
    render(<Options />);
    await waitFor(() => expect(screen.getByText(/isn't set up yet/i)).toBeInTheDocument());
    expect(screen.getByText(/open the popup/i)).toBeInTheDocument();
  });
});

describe('Options — with identity', () => {
  beforeEach(async () => {
    await saveIdentity(makeIdentity());
  });

  it('renders the routing-rules heading + add-rule form', async () => {
    render(<Options />);
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /routing rules/i })).toBeInTheDocument(),
    );
    expect(screen.getByLabelText(/^name$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^match$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^value$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/send to/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add rule/i })).toBeInTheDocument();
  });

  it('shows the empty state for rules and sent log when nothing is stored', async () => {
    render(<Options />);
    await waitFor(() => expect(screen.getByText(/no rules yet\./i)).toBeInTheDocument());
    expect(screen.getByText(/nothing sent yet/i)).toBeInTheDocument();
  });

  it('lists existing rules with their pattern description and target device', async () => {
    // Seed a rule.
    await saveRule({
      id: newRuleId(),
      name: 'YouTube to phone',
      pattern: { type: 'url_contains', value: 'youtube.com' },
      targetDeviceId: '01HOTHERPHONE0000000000000',
      priority: 0,
    });
    // The fetch returns one device with the matching id so the row can
    // resolve the target device name.
    const phone = generateIdentity();
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify([
            {
              id: '01HOTHERPHONE0000000000000',
              name: 'Phone',
              signPub: bytesToB64u(phone.sign.publicKey),
              kexPub: bytesToB64u(phone.kex.publicKey),
            },
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    ) as typeof fetch;

    render(<Options />);
    await waitFor(() => expect(screen.getByText(/youtube to phone/i)).toBeInTheDocument());
    expect(screen.getByText(/URL contains "youtube\.com"/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/→ Phone/i)).toBeInTheDocument());
  });

  it('deleting a rule removes it from the list', async () => {
    await saveRule({
      id: newRuleId(),
      name: 'YouTube to phone',
      pattern: { type: 'url_contains', value: 'youtube.com' },
      targetDeviceId: '01HOTHERPHONE0000000000000',
      priority: 0,
    });

    render(<Options />);
    await waitFor(() => expect(screen.getByText(/youtube to phone/i)).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /^delete$/i }));

    await waitFor(() => expect(screen.queryByText(/youtube to phone/i)).not.toBeInTheDocument());
    expect(screen.getByText(/no rules yet\./i)).toBeInTheDocument();
  });

  it('renders sent log items with summary, kind icon, and recipient device names', async () => {
    await recordSend({
      kind: 'url',
      recipientIds: ['01HOTHERPHONE0000000000000'],
      summary: 'https://example.com/article',
    });
    await recordSend({
      kind: 'note',
      recipientIds: ['01HOTHERPHONE0000000000000'],
      summary: 'remember to buy bread',
    });

    const phone = generateIdentity();
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify([
            {
              id: '01HOTHERPHONE0000000000000',
              name: 'Phone',
              signPub: bytesToB64u(phone.sign.publicKey),
              kexPub: bytesToB64u(phone.kex.publicKey),
            },
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    ) as typeof fetch;

    render(<Options />);
    await waitFor(() => expect(screen.getByText(/example.com\/article/)).toBeInTheDocument());
    expect(screen.getByText(/remember to buy bread/)).toBeInTheDocument();
    expect(screen.getByText(/📝/)).toBeInTheDocument();
    // Recipient name resolves once /api/v1/devices returns.
    await waitFor(() => expect(screen.getAllByText(/to Phone/).length).toBeGreaterThan(0));
  });

  it('clear-sent wipes the log after a confirm', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await recordSend({
      kind: 'note',
      recipientIds: ['01HOTHERPHONE0000000000000'],
      summary: 'goodbye',
    });

    render(<Options />);
    await waitFor(() => expect(screen.getByText(/goodbye/)).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /^clear$/i }));

    await waitFor(() => expect(screen.getByText(/nothing sent yet/i)).toBeInTheDocument());
  });
});
