import 'fake-indexeddb/auto';
import { b64uToBytes, decryptPayload, generateIdentity, unwrapKey } from '@routr/crypto';
import { canonicalize } from '@routr/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveIdentity } from './keystore.js';
import { sendFile, sendNote, sendUrl } from './sender.js';
import { clearSent, listSent } from './sent.js';

type CapturedRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
};

function makeIdentity() {
  const id = generateIdentity();
  return {
    deviceId: '01HSENDER12345678901234567',
    userId: '01HUSER1234567890123456789',
    serverUrl: 'http://example.test',
    signSecretKey: id.sign.secretKey,
    signPublicKey: id.sign.publicKey,
    kexSecretKey: id.kex.secretKey,
    kexPublicKey: id.kex.publicKey,
  };
}

function makeRecipient() {
  const id = generateIdentity();
  return {
    id: '01HRECIPIENT0123456789ABCD',
    kexPub: Buffer.from(id.kex.publicKey).toString('base64url'),
    secretKey: id.kex.secretKey,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(async () => {
  await clearSent();
});

describe('sendUrl', () => {
  it('posts a signed envelope and records to the sent log', async () => {
    const identity = makeIdentity();
    await saveIdentity(identity);
    const recipient = makeRecipient();

    const captured: CapturedRequest[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        captured.push({
          url,
          method: init?.method ?? 'GET',
          headers: (init?.headers as Record<string, string>) ?? {},
          body: init?.body,
        });
        return new Response(JSON.stringify({ id: '01HXXXXXXXXXXXXXXXXXXXXXXX' }), { status: 201 });
      }),
    );

    await sendUrl(
      identity,
      [{ id: recipient.id, kexPub: recipient.kexPub }],
      'https://example.com',
    );

    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toBe('http://example.test/api/v1/envelopes');
    expect(captured[0]?.method).toBe('POST');

    const body = JSON.parse(String(captured[0]?.body)) as {
      v: number;
      from: string;
      to: string[];
      kind: string;
      ciphertext: string;
      senderEphemeralPub: string;
      wrappedKeys: Record<string, string>;
      signature: string;
    };
    expect(body.from).toBe(identity.deviceId);
    expect(body.to).toEqual([recipient.id]);
    expect(body.kind).toBe('url');
    expect(body.wrappedKeys[recipient.id]).toBeTruthy();
    expect(body.signature).toBeTruthy();

    // Sent log got an entry.
    const sent = await listSent();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.kind).toBe('url');
    expect(sent[0]?.summary).toBe('https://example.com');
    expect(sent[0]?.recipientIds).toEqual([recipient.id]);
  });

  it('multi-recipient: includes one wrappedKey per recipient, all decrypt the same payload', async () => {
    const identity = makeIdentity();
    await saveIdentity(identity);
    const r1 = makeRecipient();
    const r2 = { ...makeRecipient(), id: '01HRECIPIENT22222222222222' };

    let captured: { url: string; body: string } | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        captured = { url, body: String(init?.body) };
        return new Response(JSON.stringify({ id: '01HYYYYYYYYYYYYYYYYYYYYYY' }), { status: 201 });
      }),
    );

    await sendUrl(
      identity,
      [
        { id: r1.id, kexPub: r1.kexPub },
        { id: r2.id, kexPub: r2.kexPub },
      ],
      'https://multi.example.com',
    );
    if (!captured) throw new Error('no request captured');
    const env = JSON.parse(captured.body) as {
      to: string[];
      wrappedKeys: Record<string, string>;
      ciphertext: string;
      senderEphemeralPub: string;
    };
    expect(env.to.sort()).toEqual([r1.id, r2.id].sort());
    expect(Object.keys(env.wrappedKeys).sort()).toEqual([r1.id, r2.id].sort());

    // Both recipients can unwrap and decrypt to identical plaintext.
    const ephPub = b64uToBytes(env.senderEphemeralPub);
    const ciphertext = b64uToBytes(env.ciphertext);
    const k1 = unwrapKey(b64uToBytes(env.wrappedKeys[r1.id] ?? ''), ephPub, r1.secretKey, r1.id);
    const k2 = unwrapKey(b64uToBytes(env.wrappedKeys[r2.id] ?? ''), ephPub, r2.secretKey, r2.id);
    const p1 = JSON.parse(new TextDecoder().decode(decryptPayload(k1, ciphertext))) as {
      url: string;
    };
    const p2 = JSON.parse(new TextDecoder().decode(decryptPayload(k2, ciphertext))) as {
      url: string;
    };
    expect(p1.url).toBe('https://multi.example.com');
    expect(p2.url).toBe('https://multi.example.com');
  });
});

describe('sendNote', () => {
  it('encrypts a note payload the recipient can decrypt', async () => {
    const identity = makeIdentity();
    await saveIdentity(identity);
    const r = makeRecipient();
    let body = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: unknown, init?: RequestInit) => {
        body = String(init?.body);
        return new Response(JSON.stringify({ id: '01HZZZZZZZZZZZZZZZZZZZZZZ' }), { status: 201 });
      }),
    );

    await sendNote(identity, [{ id: r.id, kexPub: r.kexPub }], 'remember to buy milk', 'TODO');

    const env = JSON.parse(body) as {
      kind: string;
      wrappedKeys: Record<string, string>;
      ciphertext: string;
      senderEphemeralPub: string;
    };
    expect(env.kind).toBe('note');
    const key = unwrapKey(
      b64uToBytes(env.wrappedKeys[r.id] ?? ''),
      b64uToBytes(env.senderEphemeralPub),
      r.secretKey,
      r.id,
    );
    const payload = JSON.parse(
      new TextDecoder().decode(decryptPayload(key, b64uToBytes(env.ciphertext))),
    ) as { kind: string; text: string; title?: string };
    expect(payload.kind).toBe('note');
    expect(payload.text).toBe('remember to buy milk');
    expect(payload.title).toBe('TODO');
  });
});

describe('sendFile', () => {
  it('uploads encrypted blob then sends an envelope referencing it', async () => {
    const identity = makeIdentity();
    await saveIdentity(identity);
    const r = makeRecipient();

    const calls: CapturedRequest[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        calls.push({
          url,
          method: init?.method ?? 'GET',
          headers: (init?.headers as Record<string, string>) ?? {},
          body: init?.body,
        });
        if (url.endsWith('/api/v1/blobs')) {
          return new Response(JSON.stringify({ id: 'blob-id-123', size: 0, sha256: 'a' }), {
            status: 201,
          });
        }
        return new Response(JSON.stringify({ id: 'env-id' }), { status: 201 });
      }),
    );

    const fileBytes = new TextEncoder().encode('hello file world');
    const file = new File([fileBytes], 'greeting.txt', { type: 'text/plain' });
    await sendFile(identity, [{ id: r.id, kexPub: r.kexPub }], file);

    // Two requests: blob upload, then envelope post.
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe('http://example.test/api/v1/blobs');
    expect(calls[1]?.url).toBe('http://example.test/api/v1/envelopes');

    // The envelope payload (decrypted) carries the file metadata + blobId.
    const env = JSON.parse(String(calls[1]?.body)) as {
      kind: string;
      ciphertext: string;
      senderEphemeralPub: string;
      wrappedKeys: Record<string, string>;
    };
    expect(env.kind).toBe('file');
    const key = unwrapKey(
      b64uToBytes(env.wrappedKeys[r.id] ?? ''),
      b64uToBytes(env.senderEphemeralPub),
      r.secretKey,
      r.id,
    );
    const payload = JSON.parse(
      new TextDecoder().decode(decryptPayload(key, b64uToBytes(env.ciphertext))),
    ) as { kind: string; filename: string; mime: string; blobId: string; fileKey: string };
    expect(payload.kind).toBe('file');
    expect(payload.filename).toBe('greeting.txt');
    expect(payload.mime).toBe('text/plain');
    expect(payload.blobId).toBe('blob-id-123');
    expect(payload.fileKey).toBeTruthy();
  });
});

describe('canonical-form signing', () => {
  it('signature is computed over the canonical envelope sans id and signature', async () => {
    const identity = makeIdentity();
    await saveIdentity(identity);
    const r = makeRecipient();
    let body = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: unknown, init?: RequestInit) => {
        body = String(init?.body);
        return new Response(JSON.stringify({ id: 'env-id' }), { status: 201 });
      }),
    );
    await sendUrl(identity, [{ id: r.id, kexPub: r.kexPub }], 'https://x.com');
    const env = JSON.parse(body) as Record<string, unknown>;
    const signedForm = canonicalize(
      Object.fromEntries(Object.entries(env).filter(([k]) => k !== 'id' && k !== 'signature')),
    );
    // Re-verifying with the sender's pub key should hold (regression guard
    // against accidentally reshuffling the canonical-form contract).
    const { verify } = await import('@routr/crypto');
    const ok = verify(
      identity.signPublicKey,
      b64uToBytes(env.signature as string),
      new TextEncoder().encode(signedForm),
    );
    expect(ok).toBe(true);
  });
});
