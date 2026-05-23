import { b64uToBytes, bytesToB64u, fingerprint, generateIdentity } from '@routr/crypto';
import { type FormEvent, useEffect, useState } from 'react';
import { registerDevice, signedFetch } from '../../lib/api.js';
import {
  type StoredIdentity,
  clearIdentity,
  loadIdentity,
  saveIdentity,
} from '../../lib/keystore.js';
import { listRules, suggestDevice } from '../../lib/rules.js';

type Device = { id: string; name: string; kexPub: string; signPub: string };

type State = { tag: 'loading' } | { tag: 'setup' } | { tag: 'ready'; identity: StoredIdentity };

export function Popup() {
  const [state, setState] = useState<State>({ tag: 'loading' });
  const [currentTabUrl, setCurrentTabUrl] = useState('');

  useEffect(() => {
    void loadIdentity().then((id) => {
      setState(id ? { tag: 'ready', identity: id } : { tag: 'setup' });
    });

    void browser.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (tab?.url) setCurrentTabUrl(tab.url);
    });
  }, []);

  if (state.tag === 'loading') {
    return <div className="w-72 p-4 text-sm text-gray-400">Loading…</div>;
  }

  if (state.tag === 'setup') {
    return (
      <SetupPanel
        onDone={(id) => {
          setState({ tag: 'ready', identity: id });
        }}
      />
    );
  }

  return (
    <ReadyPanel
      identity={state.identity}
      currentTabUrl={currentTabUrl}
      onForget={() => {
        void clearIdentity();
        setState({ tag: 'setup' });
      }}
    />
  );
}

// ─── Setup panel ──────────────────────────────────────────────────────────────

function SetupPanel({ onDone }: { onDone: (id: StoredIdentity) => void }) {
  const [serverUrl, setServerUrl] = useState('http://localhost:3000');
  const [deviceName, setDeviceName] = useState('Chrome Extension');
  const [invite, setInvite] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const id = generateIdentity();
      const url = serverUrl.replace(/\/$/, '');
      const { deviceId, userId } = await registerDevice(url, {
        name: deviceName,
        platform: 'chrome',
        identity: {
          signPub: bytesToB64u(id.sign.publicKey),
          kexPub: bytesToB64u(id.kex.publicKey),
        },
        ...(invite ? { invite } : {}),
      });
      const stored: StoredIdentity = {
        deviceId,
        userId,
        serverUrl: url,
        signSecretKey: id.sign.secretKey,
        signPublicKey: id.sign.publicKey,
        kexSecretKey: id.kex.secretKey,
        kexPublicKey: id.kex.publicKey,
      };
      await saveIdentity(stored);
      onDone(stored);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Setup failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="w-72 p-4">
      <h1 className="text-base font-bold text-indigo-600 mb-3">Set up Beam</h1>
      <form onSubmit={(e) => void onSubmit(e)} className="space-y-2">
        <div>
          <label htmlFor="p-server" className="block text-xs font-medium mb-0.5">
            Server URL
          </label>
          <input
            id="p-server"
            className="w-full border border-gray-300 rounded px-2 py-1 text-xs"
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
            required
          />
        </div>
        <div>
          <label htmlFor="p-name" className="block text-xs font-medium mb-0.5">
            Device name
          </label>
          <input
            id="p-name"
            className="w-full border border-gray-300 rounded px-2 py-1 text-xs"
            value={deviceName}
            onChange={(e) => setDeviceName(e.target.value)}
            required
          />
        </div>
        <div>
          <label htmlFor="p-invite" className="block text-xs font-medium mb-0.5">
            Invite code
          </label>
          <input
            id="p-invite"
            className="w-full border border-gray-300 rounded px-2 py-1 text-xs font-mono"
            value={invite}
            onChange={(e) => setInvite(e.target.value)}
            placeholder="from another device"
          />
        </div>
        {error && <p className="text-red-600 text-xs">{error}</p>}
        <button
          type="submit"
          disabled={busy}
          className="w-full bg-indigo-600 text-white rounded px-3 py-1.5 text-xs font-medium hover:bg-indigo-700 disabled:opacity-50"
        >
          {busy ? 'Setting up…' : 'Register this extension'}
        </button>
      </form>
    </div>
  );
}

// ─── Ready panel ──────────────────────────────────────────────────────────────

function ReadyPanel({
  identity,
  currentTabUrl,
  onForget,
}: { identity: StoredIdentity; currentTabUrl: string; onForget: () => void }) {
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<'sent' | 'error' | null>(null);
  const [errMsg, setErrMsg] = useState('');
  const [devices, setDevices] = useState<Device[]>([]);
  const [recipientId, setRecipientId] = useState('');

  // biome-ignore lint/correctness/useExhaustiveDependencies: currentTabUrl drives rule pre-selection
  useEffect(() => {
    void (async () => {
      try {
        const res = await signedFetch(identity, '/api/v1/devices', { method: 'GET' });
        const list = (await res.json()) as Device[];
        const others = list.filter((d) => d.id !== identity.deviceId);
        setDevices(others);
        if (others.length === 0) return;

        // Try to pre-select via a routing rule if we have a current URL.
        if (currentTabUrl) {
          const rules = await listRules();
          const target = suggestDevice(rules, currentTabUrl);
          if (target && others.some((d) => d.id === target)) {
            setRecipientId(target);
            return;
          }
        }
        if (!recipientId) setRecipientId(others[0]?.id ?? '');
      } catch {
        // ignore — UI just shows "Pair another device first"
      }
    })();
  }, [identity, currentTabUrl]);

  async function sendCurrentTab() {
    setSending(true);
    setResult(null);
    try {
      const res = (await browser.runtime.sendMessage({
        type: 'send_url',
        url: currentTabUrl,
        recipientId,
      })) as { ok: boolean; error?: string };
      if (res.ok) {
        setResult('sent');
      } else {
        setErrMsg(res.error ?? 'Failed');
        setResult('error');
      }
    } finally {
      setSending(false);
    }
  }

  async function sendFile(file: File) {
    setSending(true);
    setResult(null);
    try {
      const fileBytes = Array.from(new Uint8Array(await file.arrayBuffer()));
      const res = (await browser.runtime.sendMessage({
        type: 'send_file',
        fileBytes,
        filename: file.name,
        mime: file.type,
        recipientId,
      })) as { ok: boolean; error?: string };
      if (res.ok) {
        setResult('sent');
      } else {
        setErrMsg(res.error ?? 'Failed');
        setResult('error');
      }
    } finally {
      setSending(false);
    }
  }

  const [showFingerprints, setShowFingerprints] = useState(false);
  let ownFp = '—';
  try {
    ownFp = fingerprint(identity.signPublicKey, identity.kexPublicKey);
  } catch {
    // Malformed identity — show placeholder.
  }

  return (
    <div className="w-72 p-4">
      <div className="flex items-center justify-between mb-3">
        <span className="font-bold text-indigo-600 text-sm">Beam</span>
        <span className="text-xs text-gray-400">{identity.deviceId.slice(0, 8)}…</span>
      </div>

      {currentTabUrl && (
        <div className="mb-3">
          <p className="text-xs text-gray-500 mb-1 truncate">{currentTabUrl}</p>
          {devices.length === 0 ? (
            <p className="text-xs text-gray-400 mb-2">Pair another device first.</p>
          ) : (
            <select
              className="w-full border border-gray-300 rounded px-2 py-1 text-xs mb-2"
              value={recipientId}
              onChange={(e) => setRecipientId(e.target.value)}
            >
              {devices.map((d) => (
                <option key={d.id} value={d.id}>
                  Send to: {d.name}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            onClick={() => void sendCurrentTab()}
            disabled={sending || devices.length === 0}
            className="w-full bg-indigo-600 text-white rounded px-3 py-1.5 text-xs font-medium hover:bg-indigo-700 disabled:opacity-50"
          >
            {sending ? 'Sending…' : 'Send this tab'}
          </button>
          <label
            htmlFor="popup-file"
            className="block mt-2 text-xs text-center text-gray-600 cursor-pointer hover:text-indigo-600"
          >
            …or attach a file
            <input
              id="popup-file"
              type="file"
              className="hidden"
              disabled={sending || devices.length === 0}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void sendFile(f);
                e.target.value = '';
              }}
            />
          </label>
          {result === 'sent' && <p className="text-green-600 text-xs mt-1">Sent!</p>}
          {result === 'error' && <p className="text-red-600 text-xs mt-1">{errMsg}</p>}
        </div>
      )}

      <div className="border-t pt-2 mt-2">
        <button
          type="button"
          onClick={() => setShowFingerprints((v) => !v)}
          className="text-xs text-gray-500 hover:text-indigo-600"
        >
          {showFingerprints ? '▼' : '▶'} Fingerprints
        </button>
        {showFingerprints && (
          <div className="mt-2 space-y-2">
            <div>
              <p className="text-xs text-gray-400">This device</p>
              <p className="text-xs font-mono select-all">{ownFp}</p>
            </div>
            {devices.map((d) => {
              let fp = '—';
              try {
                fp = fingerprint(b64uToBytes(d.signPub), b64uToBytes(d.kexPub));
              } catch {
                // Malformed key bytes — show placeholder.
              }
              return (
                <div key={d.id}>
                  <p className="text-xs text-gray-400">{d.name}</p>
                  <p className="text-xs font-mono select-all">{fp}</p>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={onForget}
        className="text-xs text-gray-400 hover:text-red-500 mt-3"
      >
        Forget this device
      </button>
    </div>
  );
}
