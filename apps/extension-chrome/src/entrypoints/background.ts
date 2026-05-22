import { b64uToBytes, bytesToB64u, decryptPayload, sign, unwrapKey } from '@routr/crypto';
import { signedFetch } from '../lib/api.js';
import { clearIdentity, loadIdentity } from '../lib/keystore.js';
import { listRules, suggestDevice } from '../lib/rules.js';
import { sendFile as senderSendFile, sendUrl as senderSendUrl } from '../lib/sender.js';
import type { InboxMessage } from '../lib/ws.js';

type ServerDevice = { id: string; name: string; kexPub: string };

export default defineBackground(() => {
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
    browser.contextMenus.create({
      id: 'beam-send-image',
      title: 'Send image with Beam',
      contexts: ['image'],
    });
  });

  browser.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === 'beam-send-image' && info.srcUrl) {
      void sendImageFromUrl(info.srcUrl);
      return;
    }
    const url =
      info.menuItemId === 'beam-send-link' ? String(info.linkUrl ?? '') : String(tab?.url ?? '');
    if (url) void sendUrl(url);
  });

  async function sendImageFromUrl(srcUrl: string) {
    // Fetch the image bytes in the background context (avoids CORS in the
    // content page) and ship them as a file envelope.
    try {
      const res = await fetch(srcUrl);
      if (!res.ok) throw new Error(`fetch ${res.status}`);
      const blob = await res.blob();
      const buf = await blob.arrayBuffer();
      // Pick a filename from the URL path tail, or fall back.
      const tail = new URL(srcUrl).pathname.split('/').pop() ?? 'image';
      const filename = tail.includes('.') ? tail : `${tail}.bin`;
      await sendFile(new Uint8Array(buf), filename, blob.type || 'application/octet-stream');
      await browser.notifications.create({
        type: 'basic',
        iconUrl: '/icon/128.png',
        title: 'Beam',
        message: `Sent ${filename}`,
      });
    } catch (e) {
      await browser.notifications.create({
        type: 'basic',
        iconUrl: '/icon/128.png',
        title: 'Beam — send failed',
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  browser.action.onClicked.addListener(() => {
    void browser.action.openPopup();
  });

  browser.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
    const m = msg as {
      type: string;
      url?: string;
      recipientId?: string;
      fileBytes?: number[];
      filename?: string;
      mime?: string;
    };
    if (m.type === 'send_url' && m.url) {
      sendUrl(m.url, m.recipientId)
        .then(() => sendResponse({ ok: true }))
        .catch((e: unknown) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }
    if (m.type === 'send_file' && m.fileBytes && m.filename) {
      sendFile(new Uint8Array(m.fileBytes), m.filename, m.mime ?? '', m.recipientId)
        .then(() => sendResponse({ ok: true }))
        .catch((e: unknown) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }
    return false;
  });

  // ─── Persistent inbox WS ─────────────────────────────────────────────────

  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectDelayMs = 1000;
  const MAX_BACKOFF_MS = 60_000;

  function scheduleReconnect() {
    if (reconnectTimer) return;
    const delay = reconnectDelayMs;
    reconnectDelayMs = Math.min(delay * 2, MAX_BACKOFF_MS);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connectWs();
    }, delay);
  }

  async function connectWs() {
    const identity = await loadIdentity();
    if (!identity) return;
    const wsUrl = `${identity.serverUrl.replace(/^http/, 'ws')}/api/v1/ws`;
    ws = new WebSocket(wsUrl);
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data as string) as Record<string, unknown> & { type: string };
      if (msg.type === 'challenge' && typeof msg.nonce === 'string') {
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
      } else if (msg.type === 'authenticated') {
        // Successful handshake — reset backoff so a future drop reconnects fast.
        reconnectDelayMs = 1000;
      } else if (msg.type === 'envelope') {
        const { type: _t, ...rest } = msg;
        void handleEnvelope(rest as unknown as InboxMessage, identity);
      }
    };
    ws.onclose = (ev) => {
      if (ev.code === 4002) {
        // Server says we're an unknown device — we were revoked elsewhere.
        // Clear local identity and stop the reconnect loop.
        void clearIdentity();
        return;
      }
      scheduleReconnect();
    };
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
        filename?: string;
      };

      if (payload.kind === 'url' && payload.url) {
        await browser.notifications.create({
          type: 'basic',
          iconUrl: '/icon/128.png',
          title: 'Beam',
          message: payload.url,
        });
      } else if (payload.kind === 'file' && payload.filename) {
        await browser.notifications.create({
          type: 'basic',
          iconUrl: '/icon/128.png',
          title: 'Beam — file received',
          message: `${payload.filename} — open the Beam web app to download`,
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

  // ─── Send helpers ────────────────────────────────────────────────────────

  async function resolveRecipient(
    identity: Awaited<ReturnType<typeof loadIdentity>>,
    explicitId: string | undefined,
    url?: string,
  ): Promise<{ identity: NonNullable<typeof identity>; recipient: ServerDevice }> {
    if (!identity) throw new Error('Not set up');
    const devRes = await signedFetch(identity, '/api/v1/devices', { method: 'GET' });
    const devices = (await devRes.json()) as ServerDevice[];
    const others = devices.filter((d) => d.id !== identity.deviceId);
    if (others.length === 0) throw new Error('No other devices to send to');

    let resolved: ServerDevice | undefined;
    if (explicitId) {
      resolved = others.find((d) => d.id === explicitId);
    } else {
      if (url) {
        const rules = await listRules();
        const ruleMatch = suggestDevice(rules, url);
        if (ruleMatch) resolved = others.find((d) => d.id === ruleMatch);
      }
      if (!resolved) resolved = others[0];
    }
    if (!resolved) throw new Error('Recipient not found');
    return { identity, recipient: resolved };
  }

  async function sendUrl(url: string, recipientId?: string) {
    const id = await loadIdentity();
    const { identity, recipient } = await resolveRecipient(id, recipientId, url);
    await senderSendUrl(identity, recipient, url);
  }

  async function sendFile(data: Uint8Array, filename: string, mime: string, recipientId?: string) {
    const id = await loadIdentity();
    const { identity, recipient } = await resolveRecipient(id, recipientId);
    await senderSendFile(identity, recipient, data, filename, mime);
  }

  void connectWs();
});
