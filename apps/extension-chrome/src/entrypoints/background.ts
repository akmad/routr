import { b64uToBytes, bytesToB64u, decryptPayload, sign, unwrapKey } from '@routr/crypto';
import { signedFetch } from '../lib/api.js';
import { loadIdentity } from '../lib/keystore.js';
import type { InboxMessage } from '../lib/ws.js';

export default defineBackground(() => {
  // Set up context menu item on install.
  browser.runtime.onInstalled.addListener(() => {
    browser.contextMenus.create({
      id: 'beam-send-link',
      title: 'Send link with Beam',
      contexts: ['link'],
    });
    browser.contextMenus.create({
      id: 'beam-send-tab',
      title: 'Send this tab with Beam',
      contexts: ['page', 'action'],
    });
  });

  browser.contextMenus.onClicked.addListener((info, tab) => {
    const url =
      info.menuItemId === 'beam-send-link' ? String(info.linkUrl ?? '') : String(tab?.url ?? '');
    if (url) {
      void sendUrl(url);
    }
  });

  browser.action.onClicked.addListener((tab) => {
    void browser.action.openPopup();
    void tab;
  });

  // Listen for messages from popup.
  browser.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
    const m = msg as { type: string; url?: string; recipientId?: string };
    if (m.type === 'send_url' && m.url) {
      sendUrl(m.url, m.recipientId)
        .then(() => sendResponse({ ok: true }))
        .catch((e: unknown) => sendResponse({ ok: false, error: String(e) }));
      return true; // keep channel open for async response
    }
    return false;
  });

  // Persistent WS connection.
  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connectWs();
    }, 5000);
  }

  async function connectWs() {
    const identity = await loadIdentity();
    if (!identity) return;
    const wsUrl = `${identity.serverUrl.replace(/^http/, 'ws')}/api/v1/ws`;
    ws = new WebSocket(wsUrl);

    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data as string) as {
        type: string;
        nonce?: string;
        envelope?: InboxMessage;
      };
      if (msg.type === 'challenge' && msg.nonce) {
        const sigBytes = sign(
          identity.signSecretKey,
          new TextEncoder().encode(`routr.ws.auth.v1\n${identity.deviceId}\n${msg.nonce}\n`),
        );
        ws?.send(
          JSON.stringify({
            type: 'auth',
            deviceId: identity.deviceId,
            signature: bytesToB64u(sigBytes),
          }),
        );
      } else if (msg.type === 'inbox_envelope' && msg.envelope) {
        void handleEnvelope(msg.envelope, identity);
      }
    };
    ws.onclose = () => scheduleReconnect();
  }

  async function handleEnvelope(
    env: InboxMessage,
    identity: Awaited<ReturnType<typeof loadIdentity>>,
  ) {
    if (!identity) return;
    try {
      const payloadKey = unwrapKey(
        b64uToBytes(env.wrappedKey),
        b64uToBytes(env.senderEphemeralPub),
        identity.kexSecretKey,
        identity.deviceId,
      );
      const plaintext = decryptPayload(payloadKey, b64uToBytes(env.ciphertext));
      const payload = JSON.parse(new TextDecoder().decode(plaintext)) as {
        kind: string;
        url?: string;
      };

      if (payload.kind === 'url' && payload.url) {
        await browser.notifications.create({
          type: 'basic',
          iconUrl: '/icon/128.png',
          title: 'Beam',
          message: payload.url,
        });
      }

      await signedFetch(identity, `/api/v1/envelopes/${env.id}/ack`, {
        method: 'POST',
        body: '{}',
      });
    } catch {
      // Silently ignore decryption failures for malformed envelopes.
    }
  }

  async function sendUrl(url: string, recipientId?: string) {
    const identity = await loadIdentity();
    if (!identity) throw new Error('Not set up');

    const devRes = await signedFetch(identity, '/api/v1/devices', { method: 'GET' });
    const devices = (await devRes.json()) as Array<{ id: string; name: string; kexPub: string }>;
    const others = devices.filter((d) => d.id !== identity.deviceId);
    if (others.length === 0) throw new Error('No other devices to send to');

    // Caller can pick; otherwise fall back to the first other device (used by
    // the context menu items which don't have a UI to pick from).
    const recipient = recipientId ? others.find((d) => d.id === recipientId) : others[0];
    if (!recipient) throw new Error('Recipient not found');

    const {
      bytesToB64u: b64u,
      encryptPayload,
      generateEphemeral,
      sign: signMsg,
      wrapKey,
    } = await import('@routr/crypto');
    const { canonicalize, PROTOCOL_VERSION } = await import('@routr/protocol');

    const plaintext = new TextEncoder().encode(JSON.stringify({ kind: 'url', url }));
    const { payloadKey, ciphertext } = encryptPayload(plaintext);
    const ephem = generateEphemeral();
    const b64 = recipient.kexPub.replace(/-/g, '+').replace(/_/g, '/');
    const padded = `${b64}${'='.repeat((4 - (b64.length % 4)) % 4)}`;
    const recipientKexPub = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
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
      kind: 'url' as const,
      size: plaintext.length,
      ciphertext: b64u(ciphertext),
      senderEphemeralPub: b64u(ephem.publicKey),
      wrappedKeys: { [recipient.id]: b64u(wrapped) },
      signature: '',
    };
    const signedForm = canonicalize(
      Object.fromEntries(Object.entries(envelope).filter(([k]) => k !== 'id' && k !== 'signature')),
    );
    const sig = signMsg(identity.signSecretKey, new TextEncoder().encode(signedForm));
    await signedFetch(identity, '/api/v1/envelopes', {
      method: 'POST',
      body: JSON.stringify({ ...envelope, signature: b64u(sig) }),
    });
  }

  void connectWs();
});
