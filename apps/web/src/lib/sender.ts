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
import type { StoredIdentity } from './keystore.js';

export type Recipient = {
  id: string;
  /** base64url X25519 public key */
  kexPub: string;
};

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Copy into a fresh ArrayBuffer-backed view to satisfy WebCrypto's BufferSource type.
  const copy = new Uint8Array(bytes);
  const buf = await crypto.subtle.digest('SHA-256', copy as unknown as ArrayBuffer);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function buildAndSignEnvelope(
  identity: StoredIdentity,
  recipient: Recipient,
  plaintext: Uint8Array,
  kind: 'url' | 'file',
) {
  const { payloadKey, ciphertext } = encryptPayload(plaintext);
  const ephem = generateEphemeral();
  const recipientKexPub = b64uToBytes(recipient.kexPub);
  const wrapped = wrapKey(
    payloadKey,
    ephem.secretKey,
    ephem.publicKey,
    recipientKexPub,
    recipient.id,
  );

  const now = Date.now();
  const envelope = {
    v: PROTOCOL_VERSION,
    id: '',
    from: identity.deviceId,
    to: [recipient.id],
    createdAt: now,
    expiresAt: now + 86400_000,
    kind,
    size: plaintext.length,
    ciphertext: bytesToB64u(ciphertext),
    senderEphemeralPub: bytesToB64u(ephem.publicKey),
    wrappedKeys: { [recipient.id]: bytesToB64u(wrapped) },
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
    const body = (await res.json()) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
}

export async function sendUrl(
  identity: StoredIdentity,
  recipient: Recipient,
  url: string,
): Promise<void> {
  const plaintext = new TextEncoder().encode(JSON.stringify({ kind: 'url', url }));
  await postEnvelope(identity, buildAndSignEnvelope(identity, recipient, plaintext, 'url'));
}

/**
 * Encrypts the file, uploads the ciphertext as a blob, then sends an envelope
 * whose payload references the blob ID. The recipient fetches the blob,
 * decrypts it, and surfaces a download.
 */
export async function sendFile(
  identity: StoredIdentity,
  recipient: Recipient,
  file: File,
): Promise<void> {
  // 1. Read the file once.
  const fileBytes = new Uint8Array(await file.arrayBuffer());
  const plaintextSha = await sha256Hex(fileBytes);

  // 2. Encrypt the file under a fresh symmetric key. We reuse encryptPayload's
  //    layout (12-byte nonce || ciphertext || 16-byte tag).
  const { payloadKey: fileKey, ciphertext: encryptedFile } = encryptPayload(fileBytes);
  const blobSha = await sha256Hex(encryptedFile);

  // 3. Upload the encrypted blob.
  const ts = String(Date.now());
  const hashHex = await sha256Hex(encryptedFile);
  const sigInput = `POST\n/api/v1/blobs\n${ts}\n${hashHex}\n`;
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

  // 4. Build a file payload that references the blob + carries the file key.
  //    The payload (containing fileKey via the wrap) is then E2EE to recipients.
  const filePayload = {
    kind: 'file' as const,
    filename: file.name,
    mime: file.type || 'application/octet-stream',
    sha256: plaintextSha,
    size: fileBytes.length,
    blobId,
    fileKey: bytesToB64u(fileKey),
  };
  const payloadBytes = new TextEncoder().encode(JSON.stringify(filePayload));
  await postEnvelope(identity, buildAndSignEnvelope(identity, recipient, payloadBytes, 'file'));
}
