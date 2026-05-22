/**
 * E2E API test: exercises the full server stack over HTTP.
 * The server is started by playwright.config.ts webServer.
 * No browser needed — tests use Playwright's request context.
 */
import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';
import {
  bytesToB64u,
  encryptPayload,
  generateEphemeral,
  generateIdentity,
  sign,
  wrapKey,
} from '@routr/crypto';
import { PROTOCOL_VERSION, canonicalize } from '@routr/protocol';

function buildSignedRequestString(
  method: string,
  path: string,
  timestamp: string,
  bodyBytes: Uint8Array,
): string {
  const hash = createHash('sha256').update(bodyBytes).digest('hex');
  return `${method.toUpperCase()}\n${path}\n${timestamp}\n${hash}\n`;
}

test('health endpoint returns ok', async ({ request }) => {
  const res = await request.get('/api/v1/health');
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { ok: boolean };
  expect(body.ok).toBe(true);
});

test('full envelope round-trip: register two devices, send URL, ack', async ({ request }) => {
  const senderIdentity = generateIdentity();
  const recipientIdentity = generateIdentity();

  // Register sender (first device — no invite required on a fresh server).
  const r1 = await request.post('/api/v1/devices', {
    data: {
      name: 'sender-e2e',
      platform: 'web',
      identity: {
        signPub: bytesToB64u(senderIdentity.sign.publicKey),
        kexPub: bytesToB64u(senderIdentity.kex.publicKey),
      },
    },
  });
  expect(r1.status()).toBe(201);
  const { deviceId: senderDeviceId } = (await r1.json()) as { deviceId: string; userId: string };

  // Sender issues a signup invite for the second device.
  const inviteBody = JSON.stringify({ scope: 'signup', ttl: 3600 });
  const invTs = String(Date.now());
  const invSig = buildSignedRequestString(
    'POST',
    '/api/v1/invites',
    invTs,
    new TextEncoder().encode(inviteBody),
  );
  const invSigBytes = sign(senderIdentity.sign.secretKey, new TextEncoder().encode(invSig));
  const invAuth = `Beam-Sig deviceId="${senderDeviceId}", timestamp="${invTs}", signature="${bytesToB64u(invSigBytes)}"`;

  const invRes = await request.post('/api/v1/invites', {
    headers: { authorization: invAuth },
    data: { scope: 'signup', ttl: 3600 },
  });
  expect(invRes.status()).toBe(201);
  const { token } = (await invRes.json()) as { token: string };

  // Register recipient using the invite.
  const r2 = await request.post('/api/v1/devices', {
    data: {
      name: 'recipient-e2e',
      platform: 'android',
      identity: {
        signPub: bytesToB64u(recipientIdentity.sign.publicKey),
        kexPub: bytesToB64u(recipientIdentity.kex.publicKey),
      },
      invite: token,
    },
  });
  expect(r2.status()).toBe(201);
  const { deviceId: recipientDeviceId } = (await r2.json()) as { deviceId: string };

  // Build an E2EE envelope from sender → recipient.
  const plaintext = new TextEncoder().encode(
    JSON.stringify({ kind: 'url', url: 'https://example.com' }),
  );
  const { payloadKey, ciphertext } = encryptPayload(plaintext);
  const ephem = generateEphemeral();
  const wrapped = wrapKey(
    payloadKey,
    ephem.secretKey,
    ephem.publicKey,
    recipientIdentity.kex.publicKey,
    recipientDeviceId,
  );

  const now = Date.now();
  const envelope = {
    v: PROTOCOL_VERSION,
    id: '',
    from: senderDeviceId,
    to: [recipientDeviceId],
    createdAt: now,
    expiresAt: now + 86400_000,
    kind: 'url' as const,
    size: plaintext.length,
    ciphertext: bytesToB64u(ciphertext),
    senderEphemeralPub: bytesToB64u(ephem.publicKey),
    wrappedKeys: { [recipientDeviceId]: bytesToB64u(wrapped) },
    signature: '',
  };
  const signedForm = canonicalize(
    Object.fromEntries(Object.entries(envelope).filter(([k]) => k !== 'id' && k !== 'signature')),
  );
  const sig = sign(senderIdentity.sign.secretKey, new TextEncoder().encode(signedForm));
  const signedEnvelope = { ...envelope, signature: bytesToB64u(sig) };

  const postRes = await request.post('/api/v1/envelopes', { data: signedEnvelope });
  expect(postRes.status()).toBe(201);
  const { id: envelopeId } = (await postRes.json()) as { id: string };
  expect(envelopeId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

  // Recipient acks the envelope via signed request.
  const ackBody = '{}';
  const ackTs = String(Date.now());
  const ackPath = `/api/v1/envelopes/${envelopeId}/ack`;
  const ackSigStr = buildSignedRequestString(
    'POST',
    ackPath,
    ackTs,
    new TextEncoder().encode(ackBody),
  );
  const ackSigBytes = sign(recipientIdentity.sign.secretKey, new TextEncoder().encode(ackSigStr));
  const ackAuth = `Beam-Sig deviceId="${recipientDeviceId}", timestamp="${ackTs}", signature="${bytesToB64u(ackSigBytes)}"`;

  const ackRes = await request.post(ackPath, {
    headers: { authorization: ackAuth },
    data: {},
  });
  expect(ackRes.status()).toBe(200);
  const ackResult = (await ackRes.json()) as { ok: boolean; deleted: boolean };
  expect(ackResult.ok).toBe(true);
  expect(ackResult.deleted).toBe(true);
});
