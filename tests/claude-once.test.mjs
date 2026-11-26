// Postbox’s own cheap calls through Claude Code’s CLI (server/claude-once.mjs): what the CLI is asked with, what
// counts as its answer, and where the CLI is found. A fake spawn stands in for the CLI.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { claudeHere, claudeOnce } from '../server/claude-once.mjs';

/** A fake claude that prints `out` once its input ends, then closes; with out null it never answers. */
function fakeClaude(out, seen = []) {
  const spawnImpl = (/** @type {string} */ bin, /** @type {string[]} */ args, /** @type {any} */ opts) => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), exitCode: null, signalCode: null, killed: [] });
    child.kill = (/** @type {string} */ signal) => {
      child.killed.push(signal);
      setImmediate(() => child.emit('close', null));
      return true;
    };
    let prompt = '';
    child.stdin.on('data', (d) => {
      prompt += d;
    });
    child.stdin.on('end', () => {
      seen.push({ bin, args, opts, prompt, child });
      if (out === null) return;
      child.stdout.write(out);
      setImmediate(() => child.emit('close', 0));
    });
    return child;
  };
  return { seen, spawnImpl: /** @type {any} */ (spawnImpl) };
}

const RESULT = { type: 'result', subtype: 'success', is_error: false, result: 'Offsets chosen over pages', total_cost_usd: 0.0004 };

test('claudeOnce sends the prompt on the CLI’s input, for one turn with no tools, settings or saved session, and answers with its result and cost', async () => {
  const cli = fakeClaude(JSON.stringify(RESULT));
  const answer = await claudeOnce('/bin/claude', 'Summarize this.', { model: 'haiku', timeoutMs: 1000, spawnImpl: cli.spawnImpl });
  assert.deepEqual(answer, { text: 'Offsets chosen over pages', costUsd: 0.0004 });
  const [run] = cli.seen;
  assert.equal(run.bin, '/bin/claude');
  assert.equal(run.prompt, 'Summarize this.');
  assert.equal(run.args.join(' '), '-p --output-format json --model haiku --max-turns 1 --tools= --setting-sources= --no-session-persistence');
  assert.ok(!run.args.includes('Summarize this.'), 'the prompt is never an argument, where a leading dash would read as an option');
});

test('claudeOnce reads the result out of a list of the run’s messages too', async () => {
  const cli = fakeClaude(JSON.stringify([{ type: 'system', subtype: 'init' }, RESULT]));
  const answer = await claudeOnce('claude', 'p', { model: 'haiku', timeoutMs: 1000, spawnImpl: cli.spawnImpl });
  assert.equal(answer?.text, 'Offsets chosen over pages');
});

test('claudeOnce has no answer when the CLI’s result is an error, isn’t JSON, or the CLI can’t start', async () => {
  const ask = (/** @type {any} */ spawnImpl) => claudeOnce('claude', 'p', { model: 'haiku', timeoutMs: 1000, spawnImpl });
  assert.equal(await ask(fakeClaude(JSON.stringify({ ...RESULT, subtype: 'error_max_turns' })).spawnImpl), null);
  assert.equal(await ask(fakeClaude(JSON.stringify({ ...RESULT, is_error: true })).spawnImpl), null, 'a result that says it failed, such as not signed in');
  assert.equal(await ask(fakeClaude('Not logged in').spawnImpl), null);
  assert.equal(await ask(fakeClaude('').spawnImpl), null);
  assert.equal(
    await ask(() => {
      throw new Error('spawn ENOENT');
    }),
    null,
  );
});

test('claudeOnce stops a CLI that doesn’t answer in time, and has no answer', async (t) => {
  const cli = fakeClaude(null);
  // The call’s own timer doesn’t hold the process open (unref), and a fake CLI holds nothing: this does, until it fires.
  const held = setInterval(() => {}, 1000);
  t.after(() => clearInterval(held));
  const answer = await claudeOnce('claude', 'p', { model: 'haiku', timeoutMs: 5, spawnImpl: cli.spawnImpl });
  assert.equal(answer, null);
  assert.deepEqual(cli.seen[0].child.killed, ['SIGTERM']);
});

test('claudeHere is Claude Code’s CLI only when Claude Code runs on this computer', () => {
  const registry = (/** @type {string[]} */ names, here = true) => ({ names: () => names, runsHere: () => here, get: () => ({ bin: '/bin/claude' }) });
  assert.equal(claudeHere(registry(['claude-code'])), '/bin/claude');
  assert.equal(claudeHere(registry(['claude-code'], false)), null, 'registered for hosts only: no CLI here');
  assert.equal(claudeHere(registry(['mock', 'codex'])), null, 'not registered: POSTBOX_BACKENDS=mock, or the demo');
});
