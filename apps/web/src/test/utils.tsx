import { generateIdentity } from '@routr/crypto';
import { type RenderOptions, type RenderResult, render } from '@testing-library/react';
import type { ReactElement } from 'react';
import type { StoredIdentity } from '../lib/keystore.js';
import { IdentityContext } from '../stores/identity.js';

export function makeIdentity(overrides: Partial<StoredIdentity> = {}): StoredIdentity {
  const id = generateIdentity();
  return {
    deviceId: '01HTESTDEVICE12345678901234',
    userId: '01HTESTUSER123456789012345',
    serverUrl: 'http://test.local',
    signSecretKey: id.sign.secretKey,
    signPublicKey: id.sign.publicKey,
    kexSecretKey: id.kex.secretKey,
    kexPublicKey: id.kex.publicKey,
    ...overrides,
  };
}

export function renderWithIdentity(
  ui: ReactElement,
  identity: StoredIdentity = makeIdentity(),
  options?: RenderOptions,
): RenderResult & { identity: StoredIdentity } {
  const result = render(
    <IdentityContext.Provider value={identity}>{ui}</IdentityContext.Provider>,
    options,
  );
  return { ...result, identity };
}
