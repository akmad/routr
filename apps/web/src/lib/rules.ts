import { openBeamDb } from './db.js';

/**
 * Routing rules — client-side only.
 *
 * Rules let users say "URLs containing youtube.com → send to my phone"
 * without the server seeing the URL contents (everything client-side,
 * E2EE preserved).
 *
 * Each rule has a pattern (matches a URL or file) and a target device.
 * When composing a send, the matcher returns the highest-priority
 * matching rule's targetDeviceId, if any.
 */

export type RulePattern =
  | { type: 'url_contains'; value: string }
  | { type: 'url_regex'; value: string }
  | { type: 'mime_prefix'; value: string }
  | { type: 'file_ext'; value: string }
  | { type: 'kind'; value: 'url' | 'file' };

export type Rule = {
  id: string;
  name: string;
  pattern: RulePattern;
  targetDeviceId: string;
  /** Higher first. Default 0. */
  priority: number;
};

const STORE = 'rules';

export async function listRules(): Promise<Rule[]> {
  const db = await openBeamDb();
  const all = (await db.getAll(STORE)) as Rule[];
  return all.sort((a, b) => b.priority - a.priority);
}

export async function saveRule(rule: Rule): Promise<void> {
  const db = await openBeamDb();
  await db.put(STORE, rule);
}

export async function deleteRule(id: string): Promise<void> {
  const db = await openBeamDb();
  await db.delete(STORE, id);
}

export function newRuleId(): string {
  return crypto.randomUUID();
}

// ─── Matching ────────────────────────────────────────────────────────────────

export type Candidate = { kind: 'url'; url: string } | { kind: 'file'; name: string; mime: string };

function fileExt(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

export function matchesPattern(pattern: RulePattern, c: Candidate): boolean {
  switch (pattern.type) {
    case 'kind':
      return c.kind === pattern.value;
    case 'url_contains':
      return c.kind === 'url' && c.url.includes(pattern.value);
    case 'url_regex':
      if (c.kind !== 'url') return false;
      try {
        return new RegExp(pattern.value).test(c.url);
      } catch {
        return false;
      }
    case 'mime_prefix':
      return c.kind === 'file' && c.mime.startsWith(pattern.value);
    case 'file_ext':
      return c.kind === 'file' && fileExt(c.name) === pattern.value.toLowerCase();
  }
}

/** Return the highest-priority matching rule's target device, or null. */
export function suggestDevice(rules: Rule[], candidate: Candidate): string | null {
  for (const r of rules) {
    if (matchesPattern(r.pattern, candidate)) return r.targetDeviceId;
  }
  return null;
}
