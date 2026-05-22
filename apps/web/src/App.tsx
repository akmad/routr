import { useEffect, useState } from 'react';
import type { StoredIdentity } from './lib/keystore.js';
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

  const identity: StoredIdentity | null = state.status === 'authenticated' ? state.identity : null;

  return (
    <IdentityContext.Provider value={identity}>
      <AppRouter />
    </IdentityContext.Provider>
  );
}
