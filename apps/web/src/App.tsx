import { WrongPassphraseError } from '@routr/crypto';
import { type FormEvent, useEffect, useState } from 'react';
import { type StoredIdentity, loadEncryptedIdentity } from './lib/keystore.js';
import { AppRouter } from './router.js';
import { IdentityContext, type IdentityState, attemptLoad } from './stores/identity.js';

export function App() {
  const [state, setState] = useState<IdentityState>({ status: 'loading' });

  useEffect(() => {
    void attemptLoad().then(setState);
  }, []);

  if (state.status === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center text-gray-400 text-sm">
        Loading…
      </div>
    );
  }

  if (state.status === 'unauthenticated') {
    if (!window.location.pathname.startsWith('/setup')) {
      window.location.replace('/setup');
      return null;
    }
  }

  if (state.status === 'needs-passphrase') {
    return (
      <UnlockScreen onUnlock={(identity) => setState({ status: 'authenticated', identity })} />
    );
  }

  const identity: StoredIdentity | null = state.status === 'authenticated' ? state.identity : null;

  return (
    <IdentityContext.Provider value={identity}>
      <AppRouter />
    </IdentityContext.Provider>
  );
}

function UnlockScreen({ onUnlock }: { onUnlock: (identity: StoredIdentity) => void }) {
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const identity = await loadEncryptedIdentity(passphrase);
      onUnlock(identity);
    } catch (err) {
      if (err instanceof WrongPassphraseError) {
        setError('Wrong passphrase.');
      } else {
        setError(err instanceof Error ? err.message : 'Unlock failed');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <form
        onSubmit={(e) => void onSubmit(e)}
        className="bg-white border border-gray-200 rounded-lg shadow-sm p-6 w-full max-w-sm space-y-4"
      >
        <h1 className="text-xl font-semibold">Unlock Beam</h1>
        <p className="text-xs text-gray-500">
          Your identity is encrypted on this device. Enter your passphrase to continue.
        </p>
        <div>
          <label htmlFor="unlock-passphrase" className="block text-sm font-medium mb-1">
            Passphrase
          </label>
          <input
            id="unlock-passphrase"
            type="password"
            // biome-ignore lint/a11y/noAutofocus: unlock screen is exclusively a passphrase input; autofocus is the expected UX
            autoFocus
            className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            required
          />
        </div>
        {error && <p className="text-red-600 text-sm">{error}</p>}
        <button
          type="submit"
          disabled={busy}
          className="w-full bg-indigo-600 text-white rounded px-4 py-2 text-sm font-medium hover:bg-indigo-700 disabled:opacity-50"
        >
          {busy ? 'Unlocking…' : 'Unlock'}
        </button>
      </form>
    </div>
  );
}
