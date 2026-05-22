import { execFileSync } from 'node:child_process';

/**
 * Build/runtime fingerprint surfaced on /health. Static for the lifetime of
 * the process — call once at startup and pass into createApp().
 *
 * `gitSha` resolution order:
 *   1. BEAM_GIT_SHA env (used by Docker builds, which run from a `.git`-less
 *      filesystem so `git` can't introspect).
 *   2. `git rev-parse HEAD` against the CWD (dev workflow).
 *   3. 'unknown' when neither is available.
 *
 * Never throws — every path is wrapped so a failed lookup just leaves a
 * field as 'unknown' rather than refusing to start.
 */
export type BuildInfo = {
  gitSha: string;
  nodeVersion: string;
  startedAt: string;
};

function resolveGitSha(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.BEAM_GIT_SHA?.trim();
  if (fromEnv && /^[a-fA-F0-9]{7,40}$/.test(fromEnv)) return fromEnv;
  try {
    const out = execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (/^[a-fA-F0-9]{40}$/.test(out)) return out;
  } catch {
    // git not present, or not a repo, or any other failure — fall through.
  }
  return 'unknown';
}

export function captureBuildInfo(env: NodeJS.ProcessEnv = process.env): BuildInfo {
  return {
    gitSha: resolveGitSha(env),
    nodeVersion: process.version,
    startedAt: new Date().toISOString(),
  };
}
