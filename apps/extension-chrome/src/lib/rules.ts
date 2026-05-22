import { openDB } from 'idb';

/**
 * Routing rules — extension-local, never leave this device.
 * Mirrors apps/web/src/lib/rules.ts but with its own IndexedDB
 * (extension and web are independent Beam "devices" with independent
 * stores).
 */

export type RulePattern =
  | { type: 'url_contains'; value: string }
  | { type: 'url_regex'; value: string };

export type Rule = {
  id: string;
  name: string;
  pattern: RulePattern;
  targetDeviceId: string;
  priority: number;
};

async function open() {
  return openDB('beam-ext-rules', 1, {
    upgrade(db) {
      db.createObjectStore('rules', { keyPath: 'id' });
    },
  });
}

export async function listRules(): Promise<Rule[]> {
  const all = (await (await open()).getAll('rules')) as Rule[];
  return all.sort((a, b) => b.priority - a.priority);
}

export async function saveRule(rule: Rule): Promise<void> {
  await (await open()).put('rules', rule);
}

export async function deleteRule(id: string): Promise<void> {
  await (await open()).delete('rules', id);
}

export function newRuleId(): string {
  return crypto.randomUUID();
}

export function matchesPattern(pattern: RulePattern, url: string): boolean {
  switch (pattern.type) {
    case 'url_contains':
      return url.includes(pattern.value);
    case 'url_regex':
      try {
        return new RegExp(pattern.value).test(url);
      } catch {
        return false;
      }
  }
}

export function suggestDevice(rules: Rule[], url: string): string | null {
  for (const r of rules) {
    if (matchesPattern(r.pattern, url)) return r.targetDeviceId;
  }
  return null;
}
