// Antigravity (#585): does agy accept the plugin Postbox writes for a turn? Postbox’s own writers make the plugin in
// a temp folder, as the adapter does, and `agy plugin validate --json` (no sign-in needed) says what it loads. This
// shows agy recognizes the rules file, not that a session read it: that needs a signed-in turn.

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { agyHookCommand } from '../../server/adapters/agy-hook-check.mjs';
import { AGY_RULES_LIMIT, agyPlugin, agySkillFiles, writeAgyPlugin } from '../../server/adapters/agy-plugin.mjs';
import { AGY_SERVER } from '../../server/adapters/agy-settings.mjs';
import { agyRules } from '../../server/adapters/antigravity-cli.mjs';
import { markedGuide, newMarker, withProbeHome } from './probe-home.mjs';
import { sandboxEnv } from './sandbox-env.mjs';

const VALIDATE_MS = 30_000;

/**
 * Whether Postbox’s rules hold the whole guide within agy’s limit. A precondition, not agy’s verdict: it repeats
 * tests/agy-rules-hook.test.mjs, which runs on every gate, here against the plugin the probe hands agy.
 * @param {string} rules @param {string} guide
 */
export const rulesHold = (rules, guide) => rules.includes(guide) && rules.length <= AGY_RULES_LIMIT;

/**
 * What `agy plugin validate --json` said, as the check reads it: the rules it counted, its error findings (by file
 * and message), and whether the output could be read at all.
 * @param {string} stdout
 * @returns {{ readable: boolean, rules: number, errors: string[] }}
 */
export function parseValidate(stdout) {
  let out;
  try {
    out = JSON.parse(stdout);
  } catch {
    return { readable: false, rules: 0, errors: ['agy’s output wasn’t JSON'] };
  }
  const rules = Number(out?.components?.rules ?? 0);
  const findings = Array.isArray(out?.findings) ? out.findings : [];
  const errors = findings.filter((f) => f?.severity === 'error').map((f) => `${f.file}: ${f.message}`);
  return { readable: true, rules: Number.isFinite(rules) ? rules : 0, errors };
}

/**
 * Whether agy loaded the plugin: it exited 0, its output could be read, it counted exactly one rules file, and it
 * found no error.
 * @param {{ code: number | null }} ran @param {{ readable: boolean, rules: number, errors: string[] }} said
 */
export const validated = (ran, said) => ran.code === 0 && said.readable && said.rules === 1 && said.errors.length === 0;

/** Runs agy with an argument array and a timeout, and resolves with its exit code and output. */
function run(/** @type {string} */ bin, /** @type {string[]} */ args, /** @type {Record<string, string>} */ env, /** @type {string} */ cwd) {
  return new Promise((ok) => {
    const child = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'ignore'], signal: AbortSignal.timeout(VALIDATE_MS) });
    let stdout = '';
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.on('error', (e) => ok({ code: null, stdout, error: e.message }));
    child.on('close', (code) => ok({ code, stdout, error: null }));
  });
}

/**
 * The plugin the adapter writes for a hooked turn, with the given guide. It leaves out the folder note (`place`) the
 * adapter adds last, since that needs a worktree, so the size it reports is short of a real turn’s by that note.
 * @param {string} home @param {string} guide
 */
async function pluginFiles(home, guide) {
  const persona = { handle: 'conformance', backend: 'antigravity-cli', permissionMode: 'auto', tools: [] };
  const rules = agyRules({ persona, guide, schemas: join(home, '.gemini', 'antigravity-cli', 'mcp', AGY_SERVER), hooked: true });
  return agyPlugin({ mcpUrl: 'http://127.0.0.1:1/mcp', rules, hookCommand: agyHookCommand(), skills: await agySkillFiles(persona) });
}

/** @param {{ bin: string }} opts */
export function agyCheck({ bin }) {
  return withProbeHome(async ({ home }) => {
    const guide = markedGuide('antigravity-cli', newMarker('agy'), { setup: false });
    const dir = join(home, 'work', 'plugin');
    if (!(await writeAgyPlugin(dir, await pluginFiles(home, guide)))) throw new Error('Postbox’s writer refused the probe’s plugin folder.');
    const rules = await readFile(join(dir, 'rules', 'AGENTS.md'), 'utf8');
    const ran = await run(bin, ['plugin', 'validate', dir, '--json'], sandboxEnv({ home }), home);
    const said = parseValidate(ran.stdout);
    const loaded = validated(ran, said);
    return [
      {
        name: 'validate counts the rules file',
        ok: loaded,
        detail: `exit ${ran.code}, rules ${said.rules}, ${said.errors.length} error(s)${said.errors.length ? `: ${said.errors.join('; ')}` : ''}`,
      },
      {
        // What Postbox wrote, not what agy did with it: a precondition, so a rules file over agy’s limit is named here
        // rather than read as agy’s failure above.
        name: 'precondition: Postbox’s rules hold the guide, within agy’s limit',
        ok: rulesHold(rules, guide),
        detail: `${rules.length} of ${AGY_RULES_LIMIT} characters, without the folder note`,
      },
    ];
  });
}
