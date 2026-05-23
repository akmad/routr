import {
  b64uToBytes,
  bytesToB64u,
  decryptPayload,
  fingerprint,
  sign,
  unwrapKey,
} from '@routr/crypto';
import {
  Link,
  Navigate,
  Outlet,
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { handleRevoked, signedFetch } from './lib/api.js';
import { clearIdentity } from './lib/keystore.js';
import {
  type Rule,
  type RulePattern,
  deleteRule,
  listRules,
  newRuleId,
  saveRule,
  suggestDevice,
} from './lib/rules.js';
import { sendFile, sendNote, sendUrl } from './lib/sender.js';
import { type SentItem, clearSent, listSent } from './lib/sent.js';
import { BeamSocket, type InboxMessage } from './lib/ws.js';
import { setupIdentity, useIdentity } from './stores/identity.js';

// ─── Root layout ─────────────────────────────────────────────────────────────

function RootLayout() {
  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <nav className="border-b border-gray-200 bg-white px-4 py-3 flex gap-6 text-sm font-medium">
        <span className="font-bold text-indigo-600 mr-2">Beam</span>
        <Link
          to="/inbox"
          activeProps={{ className: 'text-indigo-600' }}
          className="hover:text-indigo-600"
        >
          Inbox
        </Link>
        <Link
          to="/send"
          activeProps={{ className: 'text-indigo-600' }}
          className="hover:text-indigo-600"
        >
          Send
        </Link>
        <Link
          to="/sent"
          activeProps={{ className: 'text-indigo-600' }}
          className="hover:text-indigo-600"
        >
          Sent
        </Link>
        <Link
          to="/devices"
          activeProps={{ className: 'text-indigo-600' }}
          className="hover:text-indigo-600"
        >
          Devices
        </Link>
        <Link
          to="/rules"
          activeProps={{ className: 'text-indigo-600' }}
          className="hover:text-indigo-600"
        >
          Rules
        </Link>
        <Link
          to="/settings"
          activeProps={{ className: 'text-indigo-600' }}
          className="hover:text-indigo-600"
        >
          Settings
        </Link>
      </nav>
      <main className="mx-auto max-w-2xl p-6">
        <Outlet />
      </main>
    </div>
  );
}

// ─── Copy-to-clipboard button ─────────────────────────────────────────────────

function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // navigator.clipboard requires a secure context; fall back to the
      // legacy hidden-textarea + execCommand path on http://… deployments.
      const ta = document.createElement('textarea');
      ta.value = value;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
      } catch {
        /* nothing left to try */
      }
      ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }
  return (
    <button
      type="button"
      onClick={() => void copy()}
      className="text-xs text-indigo-600 hover:underline shrink-0"
    >
      {copied ? 'Copied!' : label}
    </button>
  );
}

// ─── Setup page ───────────────────────────────────────────────────────────────

function defaultServerUrl(): string {
  // If the web app is served by the Beam server (the common case for a
  // self-hosted deployment behind a reverse proxy), the origin is the
  // server URL. The Vite dev proxy also forwards /api → :3000, so the
  // origin works in dev too. Fall back to localhost:3000 only if origin
  // is missing (shouldn't happen in a browser).
  if (typeof window !== 'undefined' && window.location.origin) {
    return window.location.origin;
  }
  return 'http://localhost:3000';
}

function SetupPage() {
  const [serverUrl, setServerUrl] = useState(defaultServerUrl);
  const [deviceName, setDeviceName] = useState('My Browser');
  const [invite, setInvite] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      // Probe the server before generating keys / hitting the registration
      // endpoint — gives a clear error if the URL is wrong.
      const url = serverUrl.replace(/\/$/, '');
      try {
        const probe = await fetch(`${url}/api/v1/health`);
        if (!probe.ok) throw new Error(`server returned ${probe.status}`);
        const body = (await probe.json()) as { service?: string };
        if (body.service !== 'routr') {
          throw new Error('not a Beam server at that URL');
        }
      } catch (probeErr) {
        throw new Error(
          `Can't reach server: ${probeErr instanceof Error ? probeErr.message : probeErr}`,
        );
      }
      await setupIdentity({ serverUrl: url, deviceName, invite: invite || undefined });
      window.location.href = '/inbox';
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Setup failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-sm mx-auto mt-16">
      <h1 className="text-2xl font-bold mb-6">Set up Beam</h1>
      <form onSubmit={(e) => void onSubmit(e)} className="space-y-4">
        <div>
          <label htmlFor="setup-server" className="block text-sm font-medium mb-1">
            Server URL
          </label>
          <input
            id="setup-server"
            className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
            required
          />
        </div>
        <div>
          <label htmlFor="setup-name" className="block text-sm font-medium mb-1">
            Device name
          </label>
          <input
            id="setup-name"
            className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
            value={deviceName}
            onChange={(e) => setDeviceName(e.target.value)}
            required
          />
        </div>
        <div>
          <label htmlFor="setup-invite" className="block text-sm font-medium mb-1">
            Invite code <span className="text-gray-400">(leave blank for first device)</span>
          </label>
          <input
            id="setup-invite"
            className="w-full border border-gray-300 rounded px-3 py-2 text-sm font-mono"
            value={invite}
            onChange={(e) => setInvite(e.target.value)}
            placeholder="optional"
          />
        </div>
        {error && <p className="text-red-600 text-sm">{error}</p>}
        <button
          type="submit"
          disabled={busy}
          className="w-full bg-indigo-600 text-white rounded px-4 py-2 text-sm font-medium hover:bg-indigo-700 disabled:opacity-50"
        >
          {busy ? 'Setting up…' : 'Create device'}
        </button>
      </form>
    </div>
  );
}

// ─── Inbox page ───────────────────────────────────────────────────────────────

type DecryptedItem = {
  id: string;
  fromDevice: string;
  createdAt: number;
  kind: string;
  url?: string;
  note?: { text: string; title?: string };
  file?: { name: string; mime: string; size: number; blobId: string; fileKey: string };
  error?: string;
};

function decryptEnvelope(
  msg: InboxMessage,
  kexSecretKey: Uint8Array,
  deviceId: string,
): DecryptedItem {
  try {
    const wrapped = b64uToBytes(msg.wrappedKey);
    const ephPub = b64uToBytes(msg.senderEphemeralPub);
    const payloadKey = unwrapKey(wrapped, ephPub, kexSecretKey, deviceId);
    const plaintext = decryptPayload(payloadKey, b64uToBytes(msg.ciphertext));
    const payload = JSON.parse(new TextDecoder().decode(plaintext)) as {
      kind: string;
      url?: string;
      text?: string;
      title?: string;
      filename?: string;
      mime?: string;
      size?: number;
      blobId?: string;
      fileKey?: string;
    };
    const base = {
      id: msg.id,
      fromDevice: msg.fromDevice,
      createdAt: msg.createdAt,
      kind: msg.kind,
    };
    if (payload.kind === 'file' && payload.blobId && payload.fileKey && payload.filename) {
      return {
        ...base,
        file: {
          name: payload.filename,
          mime: payload.mime ?? 'application/octet-stream',
          size: payload.size ?? 0,
          blobId: payload.blobId,
          fileKey: payload.fileKey,
        },
      };
    }
    if (payload.kind === 'note' && typeof payload.text === 'string') {
      const note: { text: string; title?: string } = { text: payload.text };
      if (payload.title) note.title = payload.title;
      return { ...base, note };
    }
    return { ...base, url: payload.url };
  } catch {
    return {
      id: msg.id,
      fromDevice: msg.fromDevice,
      createdAt: msg.createdAt,
      kind: msg.kind,
      error: 'Decryption failed',
    };
  }
}

async function downloadAndDecryptFile(
  identity: { serverUrl: string; deviceId: string; signSecretKey: Uint8Array },
  file: { name: string; mime: string; blobId: string; fileKey: string },
): Promise<void> {
  // Fetch the blob via signed GET.
  const path = `/api/v1/blobs/${file.blobId}`;
  const ts = String(Date.now());
  const emptyHash = '';
  // Empty body: hex(sha256("")) = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
  const sigInput = `GET\n${path}\n${ts}\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\n`;
  const sigBytes = sign(identity.signSecretKey, new TextEncoder().encode(sigInput));
  const authHeader = `Beam-Sig deviceId="${identity.deviceId}", timestamp="${ts}", signature="${bytesToB64u(sigBytes)}"`;
  void emptyHash;

  const res = await fetch(`${identity.serverUrl}${path}`, {
    headers: { authorization: authHeader },
  });
  if (!res.ok) throw new Error(`blob fetch failed: ${res.status}`);
  const encrypted = new Uint8Array(await res.arrayBuffer());
  const fileKey = b64uToBytes(file.fileKey);
  const plaintext = decryptPayload(fileKey, encrypted);

  // Trigger a browser download.
  const blob = new Blob([plaintext as BlobPart], { type: file.mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  a.click();
  URL.revokeObjectURL(url);
}

function InboxPage() {
  const identity = useIdentity();
  const [items, setItems] = useState<DecryptedItem[]>([]);
  const [connected, setConnected] = useState(false);
  const [deviceNames, setDeviceNames] = useState<Record<string, string>>({});
  const socketRef = useRef<BeamSocket | null>(null);

  const refreshDeviceNames = async () => {
    try {
      const r = await signedFetch(identity, '/api/v1/devices', { method: 'GET' });
      const list = (await r.json()) as Array<{ id: string; name: string }>;
      const map: Record<string, string> = {};
      for (const d of list) map[d.id] = d.name;
      setDeviceNames(map);
    } catch {
      // ignore
    }
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshDeviceNames is stable
  useEffect(() => {
    void refreshDeviceNames();
  }, [identity]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshDeviceNames is stable
  useEffect(() => {
    const sock = new BeamSocket(identity);
    socketRef.current = sock;
    sock.onConnected = () => {
      setConnected(true);
      // Refresh on each successful (re)auth — picks up newly-paired devices.
      void refreshDeviceNames();
    };
    sock.onDisconnected = () => setConnected(false);
    sock.onRevoked = () => void handleRevoked();
    sock.onEnvelope = (env) => {
      const item = decryptEnvelope(env, identity.kexSecretKey, identity.deviceId);
      // Dedupe by envelope id. The server can race-deliver an envelope
      // both via live push and via the drain on reconnect; React keys
      // dedupe visually but the underlying state would otherwise hold
      // duplicates and ack twice.
      setItems((prev) => (prev.some((it) => it.id === item.id) ? prev : [item, ...prev]));
      // Only ack on successful decryption — if the local keystore is somehow
      // out of sync, we don't want to ack-and-lose. Failed envelopes stay
      // in the inbox until expiresAt, giving us another chance after a
      // reload/repair.
      if (!item.error) {
        void signedFetch(identity, `/api/v1/envelopes/${env.id}/ack`, {
          method: 'POST',
          body: '{}',
        });
      }
    };
    sock.connect();
    return () => sock.disconnect();
  }, [identity]);

  async function clearOne(id: string) {
    setItems((prev) => prev.filter((it) => it.id !== id));
    await signedFetch(identity, `/api/v1/envelopes/${id}/ack`, { method: 'POST', body: '{}' });
  }

  async function clearAll() {
    if (items.length === 0) return;
    if (!confirm(`Clear ${items.length} message${items.length === 1 ? '' : 's'} from inbox?`))
      return;
    const ids = items.map((it) => it.id);
    setItems([]);
    // One round-trip via the bulk-ack endpoint.
    await signedFetch(identity, '/api/v1/envelopes/ack-batch', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    });
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-semibold">Inbox</h1>
        <div className="flex items-center gap-2">
          {items.length > 0 && (
            <button
              type="button"
              onClick={() => void clearAll()}
              className="text-xs text-gray-500 hover:text-red-500"
            >
              Clear all
            </button>
          )}
          <span
            className={`text-xs px-2 py-1 rounded-full ${connected ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}
          >
            {connected ? 'Live' : 'Connecting…'}
          </span>
        </div>
      </div>
      {items.length === 0 && (
        <p className="text-gray-400 text-sm text-center mt-16">No messages yet.</p>
      )}
      <ul className="space-y-3">
        {items.map((item) => (
          <li key={item.id} className="bg-white border border-gray-200 rounded-lg p-4">
            {item.error ? (
              <p className="text-red-500 text-sm">{item.error}</p>
            ) : item.kind === 'url' && item.url ? (
              <a
                href={item.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-indigo-600 hover:underline text-sm break-all"
              >
                {item.url}
              </a>
            ) : item.kind === 'file' && item.file ? (
              ((file) => (
                <button
                  type="button"
                  onClick={() => void downloadAndDecryptFile(identity, file)}
                  className="text-indigo-600 hover:underline text-sm break-all text-left"
                >
                  📎 {file.name}{' '}
                  <span className="text-gray-400 text-xs">({Math.round(file.size / 1024)} KB)</span>
                </button>
              ))(item.file)
            ) : item.kind === 'note' && item.note ? (
              <div>
                {item.note.title && <p className="text-sm font-medium mb-1">{item.note.title}</p>}
                <p className="text-sm text-gray-800 whitespace-pre-wrap break-words">
                  {item.note.text}
                </p>
              </div>
            ) : (
              <p className="text-sm text-gray-600">Unsupported type: {item.kind}</p>
            )}
            <div className="flex justify-between items-end mt-1">
              <p className="text-xs text-gray-400">
                from {deviceNames[item.fromDevice] ?? `${item.fromDevice.slice(0, 8)}…`} &middot;{' '}
                {new Date(item.createdAt).toLocaleTimeString()}
              </p>
              <button
                type="button"
                onClick={() => void clearOne(item.id)}
                className="text-xs text-gray-300 hover:text-red-500"
                aria-label="Dismiss"
              >
                ×
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ─── Send page ────────────────────────────────────────────────────────────────

type Device = { id: string; name: string; kexPub: string };

function SendPage() {
  const identity = useIdentity();
  const [mode, setMode] = useState<'url' | 'file' | 'note'>('url');
  const [url, setUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [noteText, setNoteText] = useState('');
  const [devices, setDevices] = useState<Device[]>([]);
  const [recipientId, setRecipientId] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [rules, setRules] = useState<Rule[]>([]);
  const [suggestedByRule, setSuggestedByRule] = useState(false);

  useEffect(() => {
    void signedFetch(identity, '/api/v1/devices', { method: 'GET' })
      .then((r) => r.json())
      .then((data) => setDevices((data as Device[]).filter((d) => d.id !== identity.deviceId)))
      .catch(() => {});
    void listRules().then(setRules);
  }, [identity]);

  // Auto-suggest recipient based on rules when URL or file changes.
  useEffect(() => {
    if (rules.length === 0) return;
    let candidate: Parameters<typeof suggestDevice>[1] | null = null;
    if (mode === 'url' && url) candidate = { kind: 'url', url };
    else if (mode === 'file' && file)
      candidate = { kind: 'file', name: file.name, mime: file.type || 'application/octet-stream' };
    if (!candidate) {
      setSuggestedByRule(false);
      return;
    }
    const target = suggestDevice(rules, candidate);
    if (target && devices.some((d) => d.id === target)) {
      setRecipientId(target);
      setSuggestedByRule(true);
    } else {
      setSuggestedByRule(false);
    }
  }, [mode, url, file, rules, devices]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const recipients = recipientId ? devices.filter((d) => d.id === recipientId) : devices; // empty selection = "all my devices"
    if (recipients.length === 0) return;
    setStatus('sending');
    setErrorMsg('');
    try {
      if (mode === 'url') {
        await sendUrl(identity, recipients, url);
        setUrl('');
      } else if (mode === 'note') {
        await sendNote(identity, recipients, noteText);
        setNoteText('');
      } else {
        if (!file) throw new Error('No file selected');
        await sendFile(identity, recipients, file);
        setFile(null);
      }
      setStatus('sent');
      setTimeout(() => setStatus('idle'), 2000);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Send failed');
      setStatus('error');
    }
  }

  return (
    <div>
      <h1 className="text-xl font-semibold mb-4">Send</h1>
      <div className="flex gap-1 mb-4 border border-gray-200 rounded p-1 bg-white text-sm">
        <button
          type="button"
          onClick={() => setMode('url')}
          className={`flex-1 px-3 py-1.5 rounded ${mode === 'url' ? 'bg-indigo-600 text-white' : 'text-gray-600 hover:bg-gray-50'}`}
        >
          URL
        </button>
        <button
          type="button"
          onClick={() => setMode('file')}
          className={`flex-1 px-3 py-1.5 rounded ${mode === 'file' ? 'bg-indigo-600 text-white' : 'text-gray-600 hover:bg-gray-50'}`}
        >
          File
        </button>
        <button
          type="button"
          onClick={() => setMode('note')}
          className={`flex-1 px-3 py-1.5 rounded ${mode === 'note' ? 'bg-indigo-600 text-white' : 'text-gray-600 hover:bg-gray-50'}`}
        >
          Note
        </button>
      </div>
      <form
        onSubmit={(e) => void onSubmit(e)}
        onKeyDown={(e) => {
          // Cmd/Ctrl+Enter from anywhere in the form fires send. Matters
          // most in note mode where a bare Enter inserts a newline; in
          // url mode it's just consistency with the textarea.
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            e.currentTarget.requestSubmit();
          }
        }}
        className="space-y-4"
      >
        {mode === 'url' && (
          <div>
            <label htmlFor="send-url" className="block text-sm font-medium mb-1">
              URL
            </label>
            <input
              id="send-url"
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://…"
              required
            />
          </div>
        )}
        {mode === 'file' && (
          <div>
            <label htmlFor="send-file" className="block text-sm font-medium mb-1">
              File
            </label>
            <input
              id="send-file"
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm file:mr-3 file:bg-indigo-50 file:text-indigo-700 file:border-0 file:rounded file:px-3 file:py-1"
              type="file"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              required
            />
            {file && (
              <p className="text-xs text-gray-500 mt-1">
                {file.name} &middot; {Math.round(file.size / 1024)} KB
              </p>
            )}
          </div>
        )}
        {mode === 'note' && (
          <div>
            <label htmlFor="send-note" className="block text-sm font-medium mb-1">
              Note
            </label>
            <textarea
              id="send-note"
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm font-sans"
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              placeholder="Anything — text, a recipe, a thought."
              rows={4}
              required
            />
          </div>
        )}
        <div>
          <label htmlFor="send-to" className="block text-sm font-medium mb-1">
            Send to{' '}
            {suggestedByRule && (
              <span className="text-xs text-indigo-600 ml-1">(suggested by rule)</span>
            )}
          </label>
          {devices.length === 0 ? (
            <p className="text-sm text-gray-400">No other devices found. Pair a device first.</p>
          ) : (
            <select
              id="send-to"
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
              value={recipientId}
              onChange={(e) => setRecipientId(e.target.value)}
            >
              <option value="">All my other devices ({devices.length})</option>
              {devices.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          )}
        </div>
        {status === 'error' && <p className="text-red-600 text-sm">{errorMsg}</p>}
        {status === 'sent' && <p className="text-green-600 text-sm">Sent!</p>}
        <button
          type="submit"
          disabled={status === 'sending' || devices.length === 0}
          title="Cmd/Ctrl+Enter"
          className="w-full bg-indigo-600 text-white rounded px-4 py-2 text-sm font-medium hover:bg-indigo-700 disabled:opacity-50"
        >
          {status === 'sending' ? 'Sending…' : 'Send'}
        </button>
      </form>
    </div>
  );
}

// ─── Devices page ─────────────────────────────────────────────────────────────

type DeviceInfo = {
  id: string;
  name: string;
  platform: string;
  kexPub: string;
  signPub: string;
  lastSeenAt: number | null;
};

function relativeTime(ms: number | null): string {
  if (ms == null) return 'never';
  const diffSec = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (diffSec < 60) return 'just now';
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.round(diffSec / 3600)}h ago`;
  return `${Math.round(diffSec / 86400)}d ago`;
}
type Invite = { token: string; expiresAt: number };

function DevicesPage() {
  const identity = useIdentity();
  const [devList, setDevList] = useState<DeviceInfo[]>([]);
  const [invite, setInvite] = useState<Invite | null>(null);
  const [ttl, setTtl] = useState('3600');
  const [busy, setBusy] = useState(false);
  const [revokeError, setRevokeError] = useState('');

  useEffect(() => {
    void signedFetch(identity, '/api/v1/devices', { method: 'GET' })
      .then((r) => r.json())
      .then((d) => setDevList(d as DeviceInfo[]))
      .catch(() => {});
  }, [identity]);

  async function issueInvite(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await signedFetch(identity, '/api/v1/invites', {
        method: 'POST',
        body: JSON.stringify({ scope: 'pair_device', ttl: Number(ttl) }),
      });
      setInvite((await res.json()) as Invite);
    } finally {
      setBusy(false);
    }
  }

  async function revoke(deviceId: string, deviceName: string) {
    if (!confirm(`Revoke "${deviceName}"? It will lose access immediately.`)) return;
    setRevokeError('');
    const res = await signedFetch(identity, `/api/v1/devices/${deviceId}`, { method: 'DELETE' });
    if (res.ok) {
      setDevList((prev) => prev.filter((d) => d.id !== deviceId));
    } else {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setRevokeError(`Revoke failed: ${body.error ?? res.status}`);
    }
  }

  return (
    <div>
      <h1 className="text-xl font-semibold mb-4">Devices</h1>
      <p className="text-xs text-gray-500 mb-3">
        Verify each device's fingerprint matches what's shown on that device itself, out-of-band (in
        person, over a phone call, etc).
      </p>
      {revokeError && <p className="text-sm text-red-600 mb-3">{revokeError}</p>}
      <ul className="space-y-2 mb-8">
        {devList.map((d) => {
          let fp = '—';
          try {
            fp = fingerprint(b64uToBytes(d.signPub), b64uToBytes(d.kexPub));
          } catch {
            // Malformed key bytes — show placeholder.
          }
          const isSelf = d.id === identity.deviceId;
          return (
            <li
              key={d.id}
              className={`bg-white border rounded-lg px-4 py-3 ${isSelf ? 'border-indigo-300' : 'border-gray-200'}`}
            >
              <div className="flex justify-between items-start">
                <div>
                  <p className="text-sm font-medium">
                    {d.name}{' '}
                    {isSelf && <span className="text-xs text-indigo-500 ml-1">(this device)</span>}
                  </p>
                  <p className="text-xs text-gray-400">
                    {d.platform} &middot; {d.id.slice(0, 8)}… &middot; seen{' '}
                    {relativeTime(d.lastSeenAt)}
                  </p>
                  <div className="flex items-center gap-2 mt-1">
                    <p className="text-xs font-mono text-gray-600 select-all">{fp}</p>
                    {fp !== '—' && <CopyButton value={fp} />}
                  </div>
                </div>
                {!isSelf && (
                  <button
                    type="button"
                    onClick={() => void revoke(d.id, d.name)}
                    className="text-xs text-red-500 hover:underline shrink-0 ml-2"
                  >
                    Revoke
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <div className="border-t pt-4">
        <h2 className="text-sm font-semibold mb-3">Pair a new device</h2>
        <form onSubmit={(e) => void issueInvite(e)} className="flex gap-2 items-end">
          <div className="flex-1">
            <label htmlFor="invite-ttl" className="block text-xs text-gray-500 mb-1">
              Expires in (seconds)
            </label>
            <input
              id="invite-ttl"
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
              value={ttl}
              onChange={(e) => setTtl(e.target.value)}
              type="number"
              min="60"
              max="86400"
            />
          </div>
          <button
            type="submit"
            disabled={busy}
            className="bg-indigo-600 text-white rounded px-4 py-2 text-sm font-medium hover:bg-indigo-700 disabled:opacity-50"
          >
            Generate invite
          </button>
        </form>
        {invite && (
          <div className="mt-3 bg-gray-50 border border-gray-200 rounded p-3">
            <p className="text-xs text-gray-500 mb-1">Share this code with the new device:</p>
            <div className="flex items-start gap-2">
              <code className="text-sm font-mono break-all select-all flex-1">{invite.token}</code>
              <CopyButton value={invite.token} />
            </div>
            <p className="text-xs text-gray-400 mt-1">
              Expires {new Date(invite.expiresAt).toLocaleString()} &middot; single use
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Settings page ────────────────────────────────────────────────────────────

function SettingsPage() {
  const identity = useIdentity();
  let fp = '—';
  try {
    fp = fingerprint(identity.signPublicKey, identity.kexPublicKey);
  } catch {
    // Malformed identity — show placeholder.
  }

  async function handleForget() {
    if (!confirm('Remove this device from local storage? You will need to re-register.')) return;
    await clearIdentity();
    window.location.href = '/setup';
  }

  return (
    <div>
      <h1 className="text-xl font-semibold mb-4">Settings</h1>
      <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4 space-y-2 text-sm">
        <div>
          <span className="text-gray-500">Server</span>
          <span className="ml-2 font-mono">{identity.serverUrl}</span>
        </div>
        <div>
          <span className="text-gray-500">Device ID</span>
          <span className="ml-2 font-mono text-xs">{identity.deviceId}</span>
        </div>
        <div>
          <span className="text-gray-500">Fingerprint</span>
          <div className="flex items-center gap-2 mt-0.5">
            <div className="font-mono text-xs select-all">{fp}</div>
            {fp !== '—' && <CopyButton value={fp} />}
          </div>
        </div>
        <div>
          <span className="text-gray-500">User ID</span>
          <span className="ml-2 font-mono text-xs">{identity.userId}</span>
        </div>
      </div>
      <button
        type="button"
        onClick={() => void handleForget()}
        className="text-red-600 text-sm hover:underline"
      >
        Forget this device
      </button>
      <p className="text-xs text-gray-400 mt-1">
        Clears local keys only. To remove this device from the server (so it can't receive
        messages), open the Beam app on a different device and revoke it from there.
      </p>
    </div>
  );
}

// ─── Sent page ───────────────────────────────────────────────────────────────

function SentPage() {
  const identity = useIdentity();
  const [items, setItems] = useState<SentItem[]>([]);
  const [devList, setDevList] = useState<DeviceInfo[]>([]);

  useEffect(() => {
    void listSent().then(setItems);
    void signedFetch(identity, '/api/v1/devices', { method: 'GET' })
      .then((r) => r.json())
      .then((d) => setDevList(d as DeviceInfo[]))
      .catch(() => {});
  }, [identity]);

  const deviceName = (id: string) => devList.find((d) => d.id === id)?.name ?? `${id.slice(0, 8)}…`;

  async function onClearAll() {
    if (!confirm('Clear local sent log? This only affects this device.')) return;
    await clearSent();
    setItems([]);
  }

  return (
    <div>
      <div className="flex justify-between items-start mb-1">
        <h1 className="text-xl font-semibold">Sent</h1>
        {items.length > 0 && (
          <button
            type="button"
            onClick={() => void onClearAll()}
            className="text-xs text-red-500 hover:underline"
          >
            Clear all
          </button>
        )}
      </div>
      <p className="text-xs text-gray-500 mb-4">
        Local log of what this device has sent. Server doesn't keep this — only you do.
      </p>
      {items.length === 0 ? (
        <p className="text-sm text-gray-400 text-center py-8">Nothing sent yet.</p>
      ) : (
        <ul className="space-y-3">
          {items.map((it) => (
            <li key={it.id} className="bg-white border border-gray-200 rounded-lg p-4">
              <p className="text-sm break-all">
                {it.kind === 'file' && '📎 '}
                {it.kind === 'note' && '📝 '}
                {it.summary}
              </p>
              <p className="text-xs text-gray-400 mt-1">
                to {it.recipientIds.map(deviceName).join(', ')} &middot;{' '}
                {new Date(it.at).toLocaleString()}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ─── Rules page ──────────────────────────────────────────────────────────────

function RulesPage() {
  const identity = useIdentity();
  const [rules, setRules] = useState<Rule[]>([]);
  const [devList, setDevList] = useState<DeviceInfo[]>([]);
  const [name, setName] = useState('');
  const [patternType, setPatternType] = useState<RulePattern['type']>('url_contains');
  const [patternValue, setPatternValue] = useState('');
  const [targetDeviceId, setTargetDeviceId] = useState('');

  const refresh = async () => {
    setRules(await listRules());
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh is stable
  useEffect(() => {
    void refresh();
    void signedFetch(identity, '/api/v1/devices', { method: 'GET' })
      .then((r) => r.json())
      .then((d) => setDevList(d as DeviceInfo[]))
      .catch(() => {});
  }, [identity]);

  async function add(e: FormEvent) {
    e.preventDefault();
    if (!targetDeviceId || !patternValue || !name) return;
    const pattern: RulePattern =
      patternType === 'kind'
        ? { type: 'kind', value: patternValue === 'file' ? 'file' : 'url' }
        : ({ type: patternType, value: patternValue } as RulePattern);
    const rule: Rule = {
      id: newRuleId(),
      name,
      pattern,
      targetDeviceId,
      priority: rules.length,
    };
    await saveRule(rule);
    setName('');
    setPatternValue('');
    setTargetDeviceId('');
    await refresh();
  }

  async function remove(id: string) {
    await deleteRule(id);
    await refresh();
  }

  function describePattern(p: RulePattern): string {
    switch (p.type) {
      case 'url_contains':
        return `URL contains "${p.value}"`;
      case 'url_regex':
        return `URL matches /${p.value}/`;
      case 'mime_prefix':
        return `MIME starts with "${p.value}"`;
      case 'file_ext':
        return `File ends in .${p.value}`;
      case 'kind':
        return `Kind = ${p.value}`;
    }
  }

  function deviceName(id: string): string {
    return devList.find((d) => d.id === id)?.name ?? `${id.slice(0, 8)}…`;
  }

  return (
    <div>
      <h1 className="text-xl font-semibold mb-1">Rules</h1>
      <p className="text-xs text-gray-500 mb-4">
        Auto-suggest a recipient based on what you're sending. Rules apply client-side — the server
        never sees URLs or filenames.
      </p>

      <ul className="space-y-2 mb-6">
        {rules.length === 0 && (
          <li className="text-sm text-gray-400 text-center py-4">No rules yet.</li>
        )}
        {rules.map((r) => (
          <li
            key={r.id}
            className="bg-white border border-gray-200 rounded-lg px-4 py-3 flex justify-between items-center"
          >
            <div>
              <p className="text-sm font-medium">{r.name}</p>
              <p className="text-xs text-gray-500">
                {describePattern(r.pattern)} → {deviceName(r.targetDeviceId)}
              </p>
            </div>
            <button
              type="button"
              onClick={() => void remove(r.id)}
              className="text-xs text-red-500 hover:underline"
            >
              Delete
            </button>
          </li>
        ))}
      </ul>

      <div className="border-t pt-4">
        <h2 className="text-sm font-semibold mb-3">Add a rule</h2>
        <form onSubmit={(e) => void add(e)} className="space-y-3">
          <div>
            <label htmlFor="rule-name" className="block text-xs text-gray-500 mb-1">
              Name
            </label>
            <input
              id="rule-name"
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="YouTube to phone"
              required
            />
          </div>
          <div className="flex gap-2">
            <div className="w-1/3">
              <label htmlFor="rule-pattern-type" className="block text-xs text-gray-500 mb-1">
                Pattern
              </label>
              <select
                id="rule-pattern-type"
                className="w-full border border-gray-300 rounded px-2 py-2 text-sm"
                value={patternType}
                onChange={(e) => setPatternType(e.target.value as RulePattern['type'])}
              >
                <option value="url_contains">URL contains</option>
                <option value="url_regex">URL regex</option>
                <option value="mime_prefix">MIME prefix</option>
                <option value="file_ext">File extension</option>
                <option value="kind">Kind</option>
              </select>
            </div>
            <div className="flex-1">
              <label htmlFor="rule-pattern-value" className="block text-xs text-gray-500 mb-1">
                Value
              </label>
              <input
                id="rule-pattern-value"
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
                value={patternValue}
                onChange={(e) => setPatternValue(e.target.value)}
                placeholder={patternType === 'kind' ? 'url or file' : 'youtube.com'}
                required
              />
            </div>
          </div>
          <div>
            <label htmlFor="rule-target" className="block text-xs text-gray-500 mb-1">
              Send to
            </label>
            <select
              id="rule-target"
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
              value={targetDeviceId}
              onChange={(e) => setTargetDeviceId(e.target.value)}
              required
            >
              <option value="">Pick a device…</option>
              {devList
                .filter((d) => d.id !== identity.deviceId)
                .map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
            </select>
          </div>
          <button
            type="submit"
            className="bg-indigo-600 text-white rounded px-4 py-2 text-sm font-medium hover:bg-indigo-700"
          >
            Add rule
          </button>
        </form>
      </div>
    </div>
  );
}

// ─── Route tree ───────────────────────────────────────────────────────────────

function NotFoundPage() {
  return (
    <div className="text-center mt-16">
      <p className="text-sm text-gray-500 mb-2">Nothing here.</p>
      <Link to="/inbox" className="text-sm text-indigo-600 hover:underline">
        Back to inbox →
      </Link>
    </div>
  );
}

const rootRoute = createRootRoute({
  component: RootLayout,
  notFoundComponent: NotFoundPage,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: () => <Navigate to="/inbox" />,
});

const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/setup',
  component: SetupPage,
});

const inboxRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/inbox',
  component: InboxPage,
});

const sendRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/send',
  component: SendPage,
});

const sentRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sent',
  component: SentPage,
});

const devicesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/devices',
  component: DevicesPage,
});

const rulesRouteCfg = createRoute({
  getParentRoute: () => rootRoute,
  path: '/rules',
  component: RulesPage,
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: SettingsPage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  setupRoute,
  inboxRoute,
  sendRoute,
  sentRoute,
  devicesRoute,
  rulesRouteCfg,
  settingsRoute,
]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

export function AppRouter() {
  return <RouterProvider router={router} />;
}
