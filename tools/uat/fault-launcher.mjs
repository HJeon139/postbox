#!/usr/bin/env node
// A launcher in front of an agent’s CLI that can fail one chosen turn before any output (#508, DL-3;
// designs/508/testing-strategy.md, “Seeds and runner changes”). Like tools/uat/claude-launcher.mjs, it starts the real
// CLI with the same arguments and passes its stream through. Every backend lets the runner put it in front of its CLI:
//
//   POSTBOX_CLAUDE_BIN, POSTBOX_CODEX_BIN, POSTBOX_KIRO_BIN or POSTBOX_AGY_BIN = "$PWD/tools/uat/fault-launcher.mjs"
//   POSTBOX_UAT_REAL_BIN = the real CLI it stands in for (default `claude`)
//   POSTBOX_UAT_FAULT = "fail-before-output researcher 1", or POSTBOX_UAT_FAULT_FILE = a file holding that line, read
//     at each start, so a scenario’s phase can arm it mid-run (`- fault: fail-before-output researcher 1`)
//   POSTBOX_UAT_FAULT_STATE = a folder of its own, where it counts each agent’s turns since the fault was armed
//
// On that agent’s nth turn it passes the CLI’s lines through up to its first session event, then kills the CLI and
// exits 1: a turn that started a session and failed before the model wrote anything, the case that saves the prompt
// first. The agent is the one whose guide its arguments carry (“You are @researcher”); a CLI given no guide in its
// arguments counts every turn as the faulted agent’s, so put only that agent on it. Runs that only ask the CLI its
// version or models aren’t turns.

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

/** `fail-before-output <agent> <n>` as a fault, or null. @param {string|null|undefined} line */
export function parseFault(line) {
  const m = /^\s*fail-before-output\s+@?([\w-]+)\s+(\d+)\s*$/.exec(String(line ?? ''));
  return m && Number(m[2]) >= 1 ? { kind: 'fail-before-output', agent: m[1], n: Number(m[2]), line: m[0].trim() } : null;
}

/** Postbox’s probes of a CLI, which aren’t turns: its version, its models, Codex’s app server with no turn’s config. */
export const isProbe = (argv) =>
  argv[0] === '--version' ||
  argv[0] === 'models' ||
  (argv[0] === 'chat' && argv.includes('--list-models')) ||
  (argv[0] === 'app-server' && !argv.includes('-c'));

/** The agent a turn is for, from the guide in its arguments (server/adapters/guide.mjs), or null. */
export const handleOf = (argv) => {
  for (const a of argv) {
    const m = /You are @([\w-]+), an agent in Postbox/.exec(a);
    if (m) return m[1];
  }
  return null;
};

/**
 * A backend’s first session event: Claude Code’s init, the Antigravity CLI’s init, Codex’s thread or turn starting,
 * or an ACP message (the Kiro CLI) that names its session.
 * @param {string} line
 */
export function isSessionEvent(line) {
  let e;
  try {
    e = JSON.parse(line);
  } catch {
    return false; // not a JSON line: a CLI’s plain output isn’t an event
  }
  return (
    (e?.type === 'system' && e.subtype === 'init') ||
    e?.event === 'init' ||
    e?.method === 'thread/started' ||
    e?.method === 'turn/started' ||
    typeof e?.result?.sessionId === 'string' ||
    typeof e?.params?.sessionId === 'string'
  );
}

/**
 * Counts this turn of the faulted agent, and says whether it’s the one to fail. The count starts again whenever the
 * fault’s line changes, so arming it again counts from the next turn.
 * @param {string} dir  @param {{ agent: string, n: number, line: string }} fault
 */
export function countTurn(dir, fault) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `fault-${fault.agent}.json`);
  let kept = { line: null, turns: 0 };
  try {
    kept = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    // No count yet: this is the agent’s first turn since the fault was armed.
  }
  const turns = (kept.line === fault.line ? kept.turns : 0) + 1;
  writeFileSync(file, JSON.stringify({ line: fault.line, turns }));
  return turns === fault.n;
}

/** The fault armed now: the variable, or the file a phase writes. @param {NodeJS.ProcessEnv} env */
export function armed(env) {
  if (env.POSTBOX_UAT_FAULT) return parseFault(env.POSTBOX_UAT_FAULT);
  try {
    return env.POSTBOX_UAT_FAULT_FILE ? parseFault(readFileSync(env.POSTBOX_UAT_FAULT_FILE, 'utf8')) : null;
  } catch {
    return null; // no file yet: no phase has armed a fault
  }
}

/** Whether this run of the CLI is the turn to fail. @param {string[]} argv @param {NodeJS.ProcessEnv} env */
export function shouldFail(argv, env) {
  const fault = armed(env);
  if (!fault || isProbe(argv) || !env.POSTBOX_UAT_FAULT_STATE) return false;
  const handle = handleOf(argv);
  if (handle !== null && handle !== fault.agent) return false;
  return countTurn(env.POSTBOX_UAT_FAULT_STATE, fault);
}

function run() {
  const argv = process.argv.slice(2);
  const fail = shouldFail(argv, process.env);
  const real = process.env.POSTBOX_UAT_REAL_BIN || process.env.POSTBOX_UAT_REAL_CLAUDE || 'claude';
  const child = spawn(real, argv, { stdio: ['inherit', fail ? 'pipe' : 'inherit', 'inherit'], detached: fail });
  process.on('SIGINT', () => {}); // as claude-launcher.mjs: a signal to the group reaches the CLI directly
  child.on('error', (e) => {
    console.error(`The fault launcher couldn’t start ${real}: ${e.message}`);
    process.exit(127);
  });
  child.on('exit', (code) => process.exit(fail ? 1 : (code ?? 1)));
  if (!fail || !child.stdout) return;
  createInterface({ input: child.stdout }).on('line', (line) => {
    process.stdout.write(`${line}\n`);
    if (!isSessionEvent(line)) return;
    console.error('The fault launcher failed this turn before any output, as the UAT scenario asked (fail-before-output).');
    process.kill(-(/** @type {number} */ (child.pid)), 'SIGKILL');
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run();
