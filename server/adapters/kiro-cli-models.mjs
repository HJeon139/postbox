// The kiro-cli binary, its version, and the models it offers, in Postbox’s spelling (server/adapters/kiro-cli.mjs runs it).

import { spawn } from 'node:child_process';

/** The kiro-cli binary: POSTBOX_KIRO_BIN, then the PATH. */
export const findKiro = (env = process.env) => env.POSTBOX_KIRO_BIN || 'kiro-cli';

/** The installed version (“kiro-cli 2.33.1” → “2.33.1”), or null if the CLI can’t be run. */
export function kiroVersion(bin = findKiro()) {
  return new Promise((resolve) => {
    let out = '';
    const p = spawn(bin, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const timer = setTimeout(() => p.kill(), 8000);
    p.stdout.on('data', (d) => {
      out += d;
    });
    p.on('error', () => resolve(null));
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? out.trim().split(/\s+/).at(-1) || 'unknown' : null);
    });
  });
}

/**
 * A Postbox model id in Kiro’s spelling: Kiro writes the version with a dot (`kiro-cli chat --list-models`), so
 * claude-opus-5-5 is claude-opus-5.5. Anything else, such as auto or gpt-5.6-terra, passes as it is.
 */
export const kiroModel = (id) => String(id).replace(/^(claude-[a-z]+-\d+)-(\d+)$/, '$1.$2');
/** The reverse, for what the run reports, so the model chip compares like with like; null for auto. */
export const postboxModel = (id) => (!id || id === 'auto' ? null : String(id).replace(/^(claude-[a-z]+-\d+)\.(\d+)$/, '$1-$2'));

/**
 * The models this Kiro sign-in offers, in Postbox’s spelling, for the model field’s suggestions: Claude’s, and the
 * others Kiro runs (GPT, DeepSeek, GLM and more), which is half the point of a second backend (#117). Read from
 * `kiro-cli chat --list-models --format json` ({ models: [{ model_id }] }), which runs no model. Empty if it fails.
 * @returns {Promise<string[]>}
 */
export function kiroModels(bin = findKiro()) {
  return new Promise((resolve) => {
    let out = '';
    const p = spawn(bin, ['chat', '--list-models', '--format', 'json'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const timer = setTimeout(() => p.kill(), 15000);
    p.stdout.on('data', (d) => {
      out = (out + d).slice(-200_000);
    });
    p.on('error', () => resolve([]));
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? modelIds(out) : []);
    });
  });
}

/** The model ids in a --list-models answer, bounded; auto keeps its name. */
export function modelIds(json) {
  try {
    const list = JSON.parse(json)?.models;
    if (!Array.isArray(list)) return [];
    const ids = list.map((m) => m?.model_id).filter((id) => typeof id === 'string' && /^[\w.:-]{1,80}$/.test(id));
    return [...new Set(ids.map((id) => postboxModel(id) ?? id))].slice(0, 60);
  } catch {
    return [];
  }
}
