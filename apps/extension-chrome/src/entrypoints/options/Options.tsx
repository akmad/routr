import { type FormEvent, useEffect, useState } from 'react';
import { signedFetch } from '../../lib/api.js';
import { type StoredIdentity, loadIdentity } from '../../lib/keystore.js';
import {
  type Rule,
  type RulePattern,
  deleteRule,
  listRules,
  newRuleId,
  saveRule,
} from '../../lib/rules.js';
import { type SentItem, clearSent, listSent } from '../../lib/sent.js';

type Device = { id: string; name: string };

export function Options() {
  const [identity, setIdentity] = useState<StoredIdentity | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);
  const [name, setName] = useState('');
  const [patternType, setPatternType] = useState<RulePattern['type']>('url_contains');
  const [patternValue, setPatternValue] = useState('');
  const [targetDeviceId, setTargetDeviceId] = useState('');
  const [sent, setSent] = useState<SentItem[]>([]);

  useEffect(() => {
    void loadIdentity().then(async (id) => {
      if (!id) return;
      setIdentity(id);
      const res = await signedFetch(id, '/api/v1/devices', { method: 'GET' });
      const list = (await res.json()) as Device[];
      setDevices(list.filter((d) => d.id !== id.deviceId));
      setRules(await listRules());
      setSent(await listSent());
    });
  }, []);

  async function onClearSent() {
    if (!confirm('Clear local sent log? Only affects this extension.')) return;
    await clearSent();
    setSent([]);
  }

  const deviceName = (id: string) => devices.find((d) => d.id === id)?.name ?? id.slice(0, 8);

  async function add(e: FormEvent) {
    e.preventDefault();
    if (!targetDeviceId || !patternValue || !name) return;
    await saveRule({
      id: newRuleId(),
      name,
      pattern: { type: patternType, value: patternValue } as RulePattern,
      targetDeviceId,
      priority: rules.length,
    });
    setName('');
    setPatternValue('');
    setTargetDeviceId('');
    setRules(await listRules());
  }

  async function remove(id: string, name: string) {
    if (!confirm(`Delete rule "${name}"?`)) return;
    await deleteRule(id);
    setRules(await listRules());
  }

  if (!identity) {
    return (
      <div className="max-w-xl mx-auto p-8 text-sm text-gray-500">
        This extension isn't set up yet. Open the popup to register.
      </div>
    );
  }

  return (
    <div className="max-w-xl mx-auto p-8 font-sans">
      <h1 className="text-xl font-semibold mb-1">Beam — Routing rules</h1>
      <p className="text-xs text-gray-500 mb-4">
        Pre-select a recipient when a URL matches a rule. Rules apply client-side — the server never
        sees URLs. Rules here are local to this Chrome profile; if you also use the Beam web app,
        set rules there separately.
      </p>

      <ul className="space-y-2 mb-6">
        {rules.length === 0 && (
          <li className="text-sm text-gray-400 text-center py-4 border border-dashed rounded">
            No rules yet.
          </li>
        )}
        {rules.map((r) => {
          const dev = devices.find((d) => d.id === r.targetDeviceId);
          const desc =
            r.pattern.type === 'url_contains'
              ? `URL contains "${r.pattern.value}"`
              : `URL matches /${r.pattern.value}/`;
          return (
            <li
              key={r.id}
              className="bg-white border border-gray-200 rounded-lg px-4 py-3 flex justify-between items-center"
            >
              <div>
                <p className="text-sm font-medium">{r.name}</p>
                <p className="text-xs text-gray-500">
                  {desc} → {dev?.name ?? r.targetDeviceId.slice(0, 8)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => void remove(r.id, r.name)}
                className="text-xs text-red-500 hover:underline"
              >
                Delete
              </button>
            </li>
          );
        })}
      </ul>

      <div className="border-t pt-4">
        <h2 className="text-sm font-semibold mb-3">Add a rule</h2>
        <form onSubmit={(e) => void add(e)} className="space-y-3">
          <div>
            <label htmlFor="opt-rule-name" className="block text-xs text-gray-500 mb-1">
              Name
            </label>
            <input
              id="opt-rule-name"
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="YouTube to phone"
              autoComplete="off"
              required
            />
          </div>
          <div className="flex gap-2">
            <div className="w-1/3">
              <label htmlFor="opt-pattern-type" className="block text-xs text-gray-500 mb-1">
                Match
              </label>
              <select
                id="opt-pattern-type"
                className="w-full border border-gray-300 rounded px-2 py-2 text-sm"
                value={patternType}
                onChange={(e) => setPatternType(e.target.value as RulePattern['type'])}
              >
                <option value="url_contains">contains</option>
                <option value="url_regex">regex</option>
              </select>
            </div>
            <div className="flex-1">
              <label htmlFor="opt-pattern-value" className="block text-xs text-gray-500 mb-1">
                Value
              </label>
              <input
                id="opt-pattern-value"
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
                value={patternValue}
                onChange={(e) => setPatternValue(e.target.value)}
                placeholder="youtube.com"
                autoComplete="off"
                required
              />
            </div>
          </div>
          <div>
            <label htmlFor="opt-target" className="block text-xs text-gray-500 mb-1">
              Send to
            </label>
            <select
              id="opt-target"
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
              value={targetDeviceId}
              onChange={(e) => setTargetDeviceId(e.target.value)}
              required
            >
              <option value="">Pick a device…</option>
              {devices.map((d) => (
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

      <div className="border-t pt-4 mt-8">
        <div className="flex justify-between items-center mb-3">
          <h2 className="text-sm font-semibold">Sent log</h2>
          {sent.length > 0 && (
            <button
              type="button"
              onClick={() => void onClearSent()}
              className="text-xs text-red-500 hover:underline"
            >
              Clear
            </button>
          )}
        </div>
        {sent.length === 0 ? (
          <p className="text-xs text-gray-400 text-center py-4">Nothing sent yet.</p>
        ) : (
          <ul className="space-y-2">
            {sent.slice(0, 50).map((it) => (
              <li key={it.id} className="bg-white border border-gray-200 rounded px-3 py-2">
                <p className="text-xs break-all">
                  {it.kind === 'file' && '📎 '}
                  {it.kind === 'note' && '📝 '}
                  {it.summary}
                </p>
                <p className="text-xs text-gray-400 mt-0.5">
                  to {it.recipientIds.map(deviceName).join(', ')} &middot;{' '}
                  {new Date(it.at).toLocaleString()}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
