// Finding the agy binary, its version and the models its sign-in offers, moved out of antigravity-cli.mjs.

import { spawn } from 'node:child_process';

/** The agy binary: POSTBOX_AGY_BIN, then the PATH. */
export const findAgy = (env = process.env) => env.POSTBOX_AGY_BIN || 'agy';

/** The installed version (“1.4.5”), or null if the CLI can’t be run. */
export function agyVersion(bin = findAgy()) {
  return new Promise((resolve) => {
    let out = '';
    /** @type {import('node:child_process').ChildProcessByStdio<null, import('node:stream').Readable, null>} */
    let p;
    try {
      p = spawn(bin, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return resolve(null); // a path that can’t be a binary (ENOTDIR) throws rather than emitting an error
    }
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
 * The models this sign-in offers, for the model field’s suggestions: Gemini’s, and the others agy runs (Claude,
 * GPT-OSS). Read from `agy models`, which runs no model. Empty if it fails.
 * @returns {Promise<string[]>}
 */
export function agyModels(bin = findAgy()) {
  return new Promise((resolve) => {
    let out = '';
    /** @type {import('node:child_process').ChildProcessByStdio<null, import('node:stream').Readable, null>} */
    let p;
    try {
      p = spawn(bin, ['models'], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return resolve([]);
    }
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

/**
 * The model ids in an `agy models` answer, bounded: one per line, the id, then a tab and its name
 * (“gemini-3.8-flash-high	Gemini 3.8 Flash (High)”). The “Fetching available models...” line and a sign-in
 * error aren’t ids.
 */
export function modelIds(text) {
  const ids = String(text ?? '')
    .split('\n')
    .map((l) => /^([a-z0-9][\w.:-]{0,79})\t/i.exec(l)?.[1])
    .filter((id) => typeof id === 'string');
  return [...new Set(ids)].slice(0, 60);
}
