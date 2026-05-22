import { b64uToBytes, decryptPayload, unwrapKey } from '@routr/crypto';
import { bytesToB64u, encryptPayload, generateEphemeral, sign, wrapKey } from '@routr/crypto';
import { PROTOCOL_VERSION, canonicalize } from '@routr/protocol';
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
import { signedFetch } from './lib/api.js';
import { clearIdentity } from './lib/keystore.js';
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
          to="/devices"
          activeProps={{ className: 'text-indigo-600' }}
          className="hover:text-indigo-600"
        >
          Devices
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

// ─── Setup page ───────────────────────────────────────────────────────────────

function SetupPage() {
  const [serverUrl, setServerUrl] = useState('http://localhost:3000');
  const [deviceName, setDeviceName] = useState('My Browser');
  const [invite, setInvite] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await setupIdentity({ serverUrl, deviceName, invite: invite || undefined });
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
    };
    return {
      id: msg.id,
      fromDevice: msg.fromDevice,
      createdAt: msg.createdAt,
      kind: msg.kind,
      url: payload.url,
    };
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

function InboxPage() {
  const identity = useIdentity();
  const [items, setItems] = useState<DecryptedItem[]>([]);
  const [connected, setConnected] = useState(false);
  const socketRef = useRef<BeamSocket | null>(null);

  useEffect(() => {
    const sock = new BeamSocket(identity);
    socketRef.current = sock;
    sock.onConnected = () => setConnected(true);
    sock.onDisconnected = () => setConnected(false);
    sock.onEnvelope = (env) => {
      setItems((prev) => [decryptEnvelope(env, identity.kexSecretKey, identity.deviceId), ...prev]);
      void signedFetch(identity, `/api/v1/envelopes/${env.id}/ack`, { method: 'POST', body: '{}' });
    };
    sock.connect();
    return () => sock.disconnect();
  }, [identity]);

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-semibold">Inbox</h1>
        <span
          className={`text-xs px-2 py-1 rounded-full ${connected ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}
        >
          {connected ? 'Live' : 'Connecting…'}
        </span>
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
            ) : (
              <p className="text-sm text-gray-600">Unsupported type: {item.kind}</p>
            )}
            <p className="text-xs text-gray-400 mt-1">
              from {item.fromDevice.slice(0, 8)}… &middot;{' '}
              {new Date(item.createdAt).toLocaleTimeString()}
            </p>
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
  const [url, setUrl] = useState('');
  const [devices, setDevices] = useState<Device[]>([]);
  const [recipientId, setRecipientId] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    void signedFetch(identity, '/api/v1/devices', { method: 'GET' })
      .then((r) => r.json())
      .then((data) => setDevices((data as Device[]).filter((d) => d.id !== identity.deviceId)))
      .catch(() => {});
  }, [identity]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const recipient = devices.find((d) => d.id === recipientId);
    if (!recipient) return;
    setStatus('sending');
    setErrorMsg('');
    try {
      const plaintext = new TextEncoder().encode(JSON.stringify({ kind: 'url', url }));
      const { payloadKey, ciphertext } = encryptPayload(plaintext);
      const ephem = generateEphemeral();
      // Decode base64url kexPub
      const b64 = recipient.kexPub.replace(/-/g, '+').replace(/_/g, '/');
      const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
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
        ciphertext: bytesToB64u(ciphertext),
        senderEphemeralPub: bytesToB64u(ephem.publicKey),
        wrappedKeys: { [recipient.id]: bytesToB64u(wrapped) },
        signature: '',
      };
      const signedForm = canonicalize(
        Object.fromEntries(
          Object.entries(envelope).filter(([k]) => k !== 'id' && k !== 'signature'),
        ),
      );
      const sig = sign(identity.signSecretKey, new TextEncoder().encode(signedForm));
      const res = await signedFetch(identity, '/api/v1/envelopes', {
        method: 'POST',
        body: JSON.stringify({ ...envelope, signature: bytesToB64u(sig) }),
      });
      if (!res.ok)
        throw new Error(((await res.json()) as { error?: string }).error ?? `HTTP ${res.status}`);
      setStatus('sent');
      setUrl('');
      setTimeout(() => setStatus('idle'), 2000);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Send failed');
      setStatus('error');
    }
  }

  return (
    <div>
      <h1 className="text-xl font-semibold mb-4">Send</h1>
      <form onSubmit={(e) => void onSubmit(e)} className="space-y-4">
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
        <div>
          <label htmlFor="send-to" className="block text-sm font-medium mb-1">
            Send to
          </label>
          {devices.length === 0 ? (
            <p className="text-sm text-gray-400">No other devices found. Pair a device first.</p>
          ) : (
            <select
              id="send-to"
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
              value={recipientId}
              onChange={(e) => setRecipientId(e.target.value)}
              required
            >
              <option value="">Select device…</option>
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
          className="w-full bg-indigo-600 text-white rounded px-4 py-2 text-sm font-medium hover:bg-indigo-700 disabled:opacity-50"
        >
          {status === 'sending' ? 'Sending…' : 'Send'}
        </button>
      </form>
    </div>
  );
}

// ─── Devices page ─────────────────────────────────────────────────────────────

type DeviceInfo = { id: string; name: string; platform: string };
type Invite = { token: string };

function DevicesPage() {
  const identity = useIdentity();
  const [devList, setDevList] = useState<DeviceInfo[]>([]);
  const [invite, setInvite] = useState<Invite | null>(null);
  const [ttl, setTtl] = useState('3600');
  const [busy, setBusy] = useState(false);

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

  return (
    <div>
      <h1 className="text-xl font-semibold mb-4">Devices</h1>
      <ul className="space-y-2 mb-8">
        {devList.map((d) => (
          <li
            key={d.id}
            className={`bg-white border rounded-lg px-4 py-3 ${d.id === identity.deviceId ? 'border-indigo-300' : 'border-gray-200'}`}
          >
            <p className="text-sm font-medium">
              {d.name}{' '}
              {d.id === identity.deviceId && (
                <span className="text-xs text-indigo-500 ml-1">(this device)</span>
              )}
            </p>
            <p className="text-xs text-gray-400">
              {d.platform} &middot; {d.id.slice(0, 8)}…
            </p>
          </li>
        ))}
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
            <code className="text-sm font-mono break-all select-all">{invite.token}</code>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Settings page ────────────────────────────────────────────────────────────

function SettingsPage() {
  const identity = useIdentity();

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
    </div>
  );
}

// ─── Route tree ───────────────────────────────────────────────────────────────

const rootRoute = createRootRoute({ component: RootLayout });

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

const devicesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/devices',
  component: DevicesPage,
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
  devicesRoute,
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
