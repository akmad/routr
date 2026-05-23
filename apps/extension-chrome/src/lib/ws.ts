/**
 * Wire-shape of a server-pushed envelope on the inbox WebSocket.
 *
 * (The extension's WS plumbing lives directly in entrypoints/background.ts
 * — the inline handler covers the reconnect / revocation behavior the web
 * app's BeamSocket class provides. This module is just the shared type.)
 */
export type InboxMessage = {
  id: string;
  fromDevice: string;
  kind: 'url' | 'file' | 'note' | 'control';
  ciphertext: string;
  senderEphemeralPub: string;
  wrappedKey: string;
  signature: string;
  createdAt: number;
  expiresAt: number;
  size: number;
};
