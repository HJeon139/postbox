// One answer from Claude Code’s CLI, for Postbox’s own cheap calls: a thread’s summary (server/thread-summary.mjs) and
// the check on a write the person asked for (server/write-intent.mjs). `claude -p` with the prompt on its input, one
// turn, no tools, none of the person’s settings (so no hooks, rules or steering files) and no saved session; it uses
// the sign-in Claude Code already has. Postbox never reads or stores a key.

import { spawn } from 'node:child_process';
import { stopProbe } from './remote/host/probe-stop.mjs';

/** The most of what the CLI prints that is read: its init, with every command it lists, the reply and the result. */
const MAX_OUT = 1_000_000;

/**
 * The whole system prompt of the call, in place of Claude Code’s own, which is a coding agent’s: the message says what
 * to answer. One line rather than none, so the CLI can’t read it as unset.
 */
const SYSTEM = 'Answer the message exactly as it asks.';

/**
 * The CLI’s arguments for one answer. `--output-format json --verbose` prints the run’s messages as one JSON list: its
 * init, which says what the call was offered, and its result.
 * @param {string} model
 */
const onceArgs = (model) => [
  '-p',
  '--output-format',
  'json',
  '--verbose',
  '--system-prompt',
  SYSTEM,
  '--model',
  model,
  '--max-turns',
  '1',
  '--tools=',
  '--setting-sources=',
  '--no-session-persistence',
];

/**
 * The run’s result in what the CLI printed: the object itself, or the one in a list of the run’s messages.
 * @param {string} out @returns {any}
 */
function resultIn(out) {
  try {
    const said = JSON.parse(out);
    return (Array.isArray(said) ? said : [said]).find((m) => m?.type === 'result') ?? null;
  } catch {
    return null; // Not JSON: the CLI failed before it answered.
  }
}

/**
 * Asks the model once. Null when the CLI couldn’t start, failed, ran out of time or answered with an error: the caller
 * goes on without an answer.
 * @param {string} bin  the claude CLI @param {string} prompt
 * @param {{ model: string, timeoutMs: number, spawnImpl?: typeof spawn }} opts
 * @returns {Promise<{ text: string, costUsd: number|null } | null>}
 */
export function claudeOnce(bin, prompt, { model, timeoutMs, spawnImpl = spawn }) {
  return new Promise((resolve) => {
    /** @type {any} */
    let child;
    try {
      child = spawnImpl(bin, onceArgs(model), { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      resolve(null);
      return;
    }
    let out = '';
    let late = false;
    // A call that hangs is given up, so the next one can try again.
    const timer = setTimeout(() => {
      late = true;
      stopProbe(child);
    }, timeoutMs);
    timer.unref?.();
    const finish = (/** @type {{ text: string, costUsd: number|null } | null} */ answer) => {
      clearTimeout(timer);
      resolve(answer);
    };
    child.stdout.on('data', (/** @type {Buffer} */ d) => {
      if (out.length < MAX_OUT) out += d;
    });
    child.on('error', () => finish(null));
    child.on('close', () => {
      const r = late ? null : resultIn(out);
      finish(r?.subtype === 'success' && !r.is_error ? { text: String(r.result ?? ''), costUsd: r.total_cost_usd ?? null } : null);
    });
    child.stdin.on('error', () => {}); // A CLI that exited first closes its input; its close event answers.
    child.stdin.end(prompt);
  });
}

/**
 * The CLI to ask, when Claude Code runs on this computer: null when it’s registered for hosts only, or not at all.
 * @param {{ names(): string[], runsHere?(name: string): boolean, get(name: string): any }} adapters @returns {string|null}
 */
export function claudeHere(adapters) {
  if (!adapters.names().includes('claude-code') || adapters.runsHere?.('claude-code') === false) return null;
  const bin = adapters.get('claude-code')?.bin;
  return typeof bin === 'string' && bin ? bin : null;
}
