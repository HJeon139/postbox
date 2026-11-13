// The codex binary, its version, and the models this sign-in offers (server/adapters/codex.mjs runs it).
import { spawn } from 'node:child_process';
import { versionIn } from '../../shared/cli-version.mjs';

export { codexModels } from '../remote/host/harness-models.mjs';

import { stopProbe } from '../remote/host/probe-stop.mjs';

export const findCodex = (env = process.env) => env.POSTBOX_CODEX_BIN || 'codex';

function probe(bin, args, timeout = 8000) {
  return new Promise((resolve) => {
    let out = '';
    /** @type {any} */
    let child;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => stopProbe(child), timeout);
    child.stdout.on('data', (chunk) => {
      out = (out + chunk).slice(-300_000);
    });
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? out.trim() : null);
    });
  });
}
export async function codexVersion(bin = findCodex()) {
  const out = await probe(bin, ['--version']);
  // Found when `--version` succeeds, as for the other CLIs, whatever it prints.
  if (out == null) return null;
  return versionIn(out) ?? 'unknown';
}
