// The kiro-cli binary, its version, and the models it offers, in Postbox’s spelling (server/adapters/kiro-cli.mjs runs it).

import { spawn } from 'node:child_process';
import { versionIn } from '../../shared/cli-version.mjs';

export { kiroModel, kiroModelIds as modelIds, postboxModel } from '../../shared/model-ids.mjs';
export { kiroModels } from '../remote/host/harness-models.mjs';

import { stopProbe } from '../remote/host/probe-stop.mjs';

/** The kiro-cli binary: POSTBOX_KIRO_BIN, then the PATH. */
export const findKiro = (env = process.env) => env.POSTBOX_KIRO_BIN || 'kiro-cli';

/** The installed version (“kiro-cli 2.33.1” → “2.33.1”), or null if the CLI can’t be run. */
export function kiroVersion(bin = findKiro()) {
  return new Promise((resolve) => {
    let out = '';
    const p = spawn(bin, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const timer = setTimeout(() => stopProbe(p), 8000);
    p.stdout.on('data', (d) => {
      out += d;
    });
    p.on('error', () => resolve(null));
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? (versionIn(out) ?? 'unknown') : null);
    });
  });
}
