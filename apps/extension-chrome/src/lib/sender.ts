import {
  b64uToBytes,
  bytesToB64u,
  encryptPayload,
  generateEphemeral,
  sign,
  wrapKey,
} from '@routr/crypto';
import { PROTOCOL_VERSION, canonicalize } from '@routr/protocol';
import { signedFetch } from './api.js';
import { formatBytes } from './format.js';
import type { StoredIdentity } from './keystore.js';
import { recordSend } from './sent.js';

export type Recipient = { id: string; kexPub: string };

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes);
  const buf = await crypto.subtle.digest('SHA-256', copy as unknown as ArrayBuffer);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function buildAndSignEnvelope(
  identity: StoredIdentity,
  recipients: Recipient[],
  plaintext: Uint8Array,
  kind: 'url' | 'file' | 'note',
) {
  if (recipients.length === 0) throw new Error('no recipients');
  const { payloadKey, ciphertext } = encryptPayload(plaintext);
  const ephem = generateEphemeral();
  const wrappedKeys: Record<string, string> = {};
  for (const r of recipients) {
    const recipientKexPub = b64uToBytes(r.kexPub);
    const wrapped = wrapKey(payloadKey, ephem.secretKey, ephem.publicKey, recipientKexPub, r.id);
    wrappedKeys[r.id] = bytesToB64u(wrapped);
  }
  const now = Date.now();
  const envelope = {
    v: PROTOCOL_VERSION,
    id: '',
    from: identity.deviceId,
    to: recipients.map((r) => r.id),
    createdAt: now,
    expiresAt: now + 86400_000,
    kind,
    size: plaintext.length,
    ciphertext: bytesToB64u(ciphertext),
    senderEphemeralPub: bytesToB64u(ephem.publicKey),
    wrappedKeys,
    signature: '',
  };
  const signedForm = canonicalize(
    Object.fromEntries(Object.entries(envelope).filter(([k]) => k !== 'id' && k !== 'signature')),
  );
  const sig = sign(identity.signSecretKey, new TextEncoder().encode(signedForm));
  return { ...envelope, signature: bytesToB64u(sig) };
}

async function postEnvelope(identity: StoredIdentity, envelope: unknown): Promise<void> {
  const res = await signedFetch(identity, '/api/v1/envelopes', {
    method: 'POST',
    body: JSON.stringify(envelope),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
}

export async function sendUrl(
  identity: StoredIdentity,
  recipients: Recipient[],
  url: string,
): Promise<void> {
  const plaintext = new TextEncoder().encode(JSON.stringify({ kind: 'url', url }));
  await postEnvelope(identity, buildAndSignEnvelope(identity, recipients, plaintext, 'url'));
  await recordSend({
    kind: 'url',
    recipientIds: recipients.map((r) => r.id),
    summary: url,
  });
}

export async function sendNote(
  identity: StoredIdentity,
  recipients: Recipient[],
  text: string,
  title?: string,
): Promise<void> {
  const payload: { kind: 'note'; text: string; title?: string } = { kind: 'note', text };
  if (title) payload.title = title;
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  await postEnvelope(identity, buildAndSignEnvelope(identity, recipients, plaintext, 'note'));
  await recordSend({
    kind: 'note',
    recipientIds: recipients.map((r) => r.id),
    summary: title ?? text.slice(0, 120),
  });
}

/**
 * File send: encrypt file under a fresh key, upload as a blob, then send
 * an envelope whose payload carries the blob ID + the file key. All
 * recipients share the same blob; each gets the file key wrapped under
 * their own X25519 key.
 */
export async function sendFile(
  identity: StoredIdentity,
  recipients: Recipient[],
  data: Uint8Array,
  filename: string,
  mime: string,
): Promise<void> {
  const plaintextSha = await sha256Hex(data);
  const { payloadKey: fileKey, ciphertext: encryptedFile } = encryptPayload(data);
  const blobSha = await sha256Hex(encryptedFile);

  const ts = String(Date.now());
  const sigInput = `POST\n/api/v1/blobs\n${ts}\n${blobSha}\n`;
  const sigBytes = sign(identity.signSecretKey, new TextEncoder().encode(sigInput));
  const authHeader = `Beam-Sig deviceId="${identity.deviceId}", timestamp="${ts}", signature="${bytesToB64u(sigBytes)}"`;
  const blobRes = await fetch(`${identity.serverUrl}/api/v1/blobs`, {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'x-beam-sha256': blobSha,
      authorization: authHeader,
    },
    body: encryptedFile as unknown as BodyInit,
  });
  if (!blobRes.ok) {
    const body = (await blobRes.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `blob upload failed: ${blobRes.status}`);
  }
  const { id: blobId } = (await blobRes.json()) as { id: string };

  const filePayload = {
    kind: 'file' as const,
    filename,
    mime: mime || 'application/octet-stream',
    sha256: plaintextSha,
    size: data.length,
    blobId,
    fileKey: bytesToB64u(fileKey),
  };
  const payloadBytes = new TextEncoder().encode(JSON.stringify(filePayload));
  await postEnvelope(identity, buildAndSignEnvelope(identity, recipients, payloadBytes, 'file'));
  await recordSend({
    kind: 'file',
    recipientIds: recipients.map((r) => r.id),
    summary: `${filename} (${formatBytes(data.length)})`,
  });
}
