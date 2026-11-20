// Whether Antigravity’s PreToolUse hook (agy-hook.mjs) will run for a turn: the agy version, the command agy runs it
// with, and the hooks.json that names it. Moved from agy-hook.mjs, which is at its size ceiling
// (designs/architecture/code-size.md, “Module and function size”).

import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { HOOK_SCRIPT, HOOK_TIMEOUT_S } from './agy-hook.mjs';
import { POSTBOX_SERVER } from './setup.mjs';

/** Whether an agy version supports PreToolUse hooks (1.4.7 and newer). */
export function agySupportsHooks(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version ?? '').trim());
  if (!m) return false;
  const [maj, min, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return maj > 1 || (maj === 1 && (min > 4 || (min === 4 && patch >= 7)));
}

/**
 * An absolute path as agy’s `/bin/sh -c` runner reads it: as written when it has no shell characters, else in single
 * quotes, each ' in it closed, escaped and reopened. Null for a relative path, or one that spans lines.
 * @param {unknown} p
 */
const shellPath = (p) => {
  if (typeof p !== 'string' || !p.startsWith('/') || /[\0\n\r]/.test(p)) return null;
  return /[^\w./:@+-]/.test(p) ? `'${p.replaceAll("'", "'\\''")}'` : p;
};

/**
 * The hook’s command for agy’s runner: this Node and the script, so it runs with no node on agy’s PATH, as from
 * launchd, where a `#!/usr/bin/env node` hook would print nothing, and agy fails open on that (PR #1515’s review). A
 * path with a space is quoted, not refused, which would lose the hook in every mode (its second review).
 */
export const agyHookCommand = (script = HOOK_SCRIPT, node = process.execPath) => {
  const [s, n] = [shellPath(script), shellPath(node)];
  return s && n ? `${n} ${s}` : null;
};

/** The plugin’s hooks.json content for a turn. */
export const agyHooksJson = (command = agyHookCommand(), timeout = HOOK_TIMEOUT_S) => ({
  [POSTBOX_SERVER]: {
    PreToolUse: [{ matcher: '*', hooks: [{ command, timeout }] }],
  },
});

/**
 * Confirms that PreToolUse hooks will run before passing --dangerously-skip-permissions: an agy version with hooks,
 * a hook script at a safe path, run by this Node (agyHookCommand), hooks.json written and read back intact, and the
 * hook itself answering (probe).
 * @param {{ version: string|null|undefined, pluginDir: string, script?: string, timeout?: number, probe?: typeof probeAgyHook }} opts
 */
export async function confirmAgyHook({ version, pluginDir, script = HOOK_SCRIPT, timeout = HOOK_TIMEOUT_S, probe = probeAgyHook }) {
  if (!agySupportsHooks(version)) return false;
  const command = agyHookCommand(script);
  if (!command) return false;
  const st = await stat(script).catch(() => null);
  if (!st?.isFile()) return false;
  const expected = `${JSON.stringify(agyHooksJson(command, timeout), null, 2)}\n`;
  const actual = await readFile(join(pluginDir, 'hooks.json'), 'utf8').catch(() => '');
  return actual === expected && (await probe(script));
}

/** What the probe asks: a web search, which the hook refuses in Run everything with Web off, and nothing else does. */
const PROBE_CALL = JSON.stringify({ toolCall: { name: 'search_web', args: { query: 'Postbox hook check' } } });

/**
 * Runs the hook once, as this Node and the script, on a web search in Run everything with Web off, and resolves
 * whether it answered deny. A hook that can’t load (a broken import, as one write could make) prints nothing, which
 * agy takes as allowed (PR #1515’s second review), and only running it shows that. About 60 ms, once per run of a turn.
 * @param {string} script @param {{ spawnImpl?: typeof spawn, timeoutMs?: number }} [opts]
 * @returns {Promise<boolean>}
 */
export function probeAgyHook(script, { spawnImpl = spawn, timeoutMs = 15_000 } = {}) {
  return new Promise((resolve) => {
    const env = { PATH: process.env.PATH ?? '', HOME: homedir(), POSTBOX_AGY_MODE: 'bypass', POSTBOX_AGY_TOOLS: '[]' };
    let child;
    try {
      child = spawnImpl(process.execPath, [script], { cwd: dirname(script), env, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      resolve(false); // couldn’t start: no hook
      return;
    }
    let out = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    timer.unref();
    child.stdout.on('data', (d) => {
      out = (out + d).slice(-4000);
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve(answeredDeny(out));
    });
    child.stdin.on('error', () => {}); // a hook that exits before reading its stdin is judged by what it printed
    child.stdin.end(PROBE_CALL);
  });
}

/** @param {string} out */
function answeredDeny(out) {
  try {
    return JSON.parse(out).decision === 'deny';
  } catch {
    return false; // nothing, or not one JSON answer: agy would take it as allowed
  }
}
