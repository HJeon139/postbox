// Whether Antigravity’s PreToolUse hook (agy-hook.mjs) will run for a turn: the agy version, the command agy runs it
// with, and the hooks.json that names it. Moved from agy-hook.mjs, which is at its size ceiling
// (designs/architecture/code-size.md, “Module and function size”).

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { HOOK_SCRIPT, HOOK_TIMEOUT_S } from './agy-hook.mjs';
import { POSTBOX_SERVER } from './setup.mjs';

/** Whether an agy version supports PreToolUse hooks (1.4.7 and newer). */
export function agySupportsHooks(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version ?? '').trim());
  if (!m) return false;
  const [maj, min, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return maj > 1 || (maj === 1 && (min > 4 || (min === 4 && patch >= 7)));
}

const plainPath = (/** @type {unknown} */ p) => typeof p === 'string' && p.startsWith('/') && !/[^\w./:@+-]/.test(p);
/**
 * The hook’s command for agy’s `/bin/sh -c` runner: this Node and the script, so it runs with no node on agy’s PATH,
 * as from launchd, where a `#!/usr/bin/env node` hook would print nothing, and agy fails open on that (PR #1515’s
 * review). Null if either path has shell characters.
 */
export const agyHookCommand = (script = HOOK_SCRIPT, node = process.execPath) => (plainPath(script) && plainPath(node) ? `${node} ${script}` : null);

/** The plugin’s hooks.json content for a turn. */
export const agyHooksJson = (command = agyHookCommand(), timeout = HOOK_TIMEOUT_S) => ({
  [POSTBOX_SERVER]: {
    PreToolUse: [{ matcher: '*', hooks: [{ command, timeout }] }],
  },
});

/**
 * Confirms that PreToolUse hooks will run before passing --dangerously-skip-permissions: an agy version with hooks,
 * a hook script at a safe path, run by this Node (agyHookCommand), and hooks.json written and read back intact.
 * @param {{ version: string|null|undefined, pluginDir: string, script?: string, timeout?: number }} opts
 */
export async function confirmAgyHook({ version, pluginDir, script = HOOK_SCRIPT, timeout = HOOK_TIMEOUT_S }) {
  if (!agySupportsHooks(version)) return false;
  const command = agyHookCommand(script);
  if (!command) return false;
  const st = await stat(script).catch(() => null);
  if (!st?.isFile()) return false;
  const expected = `${JSON.stringify(agyHooksJson(command, timeout), null, 2)}\n`;
  const actual = await readFile(join(pluginDir, 'hooks.json'), 'utf8').catch(() => '');
  return actual === expected;
}
