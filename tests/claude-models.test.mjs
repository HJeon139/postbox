import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { claudeModels, sdkModels } from '../server/adapters/claude-models.mjs';

// `claude -p --input-format stream-json` answering an initialize request, recorded from Claude Code 2.1.318 with
// the account fields left out: only the models it listed.
const ANSWER = readFileSync(new URL('./fixtures/claude-code/initialize-models.jsonl', import.meta.url), 'utf8').trim();
const ROWS = JSON.parse(ANSWER).response.response.models;

/** A fake claude that answers initialize with the recorded line, or exits without a word when answer is null. */
function fakeClaude(answer, seen) {
  return (_bin, args) => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), killed: false });
    child.kill = () => {
      child.killed = true;
      return true;
    };
    seen.push({ args, child, written: [] });
    child.stdin.on('data', (d) => {
      seen.at(-1).written.push(
        ...String(d)
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l)),
      );
      if (answer) child.stdout.write(`${answer}\n`);
      else setImmediate(() => child.emit('close', 1));
    });
    return child;
  };
}

test('claudeModels lists the ids the CLI’s models resolve to, in its order, once each', async () => {
  const seen = [];
  const models = await claudeModels('claude', { spawnImpl: /** @type {any} */ (fakeClaude(ANSWER, seen)) });
  assert.deepEqual(models.slice(0, 5), ['claude-opus-5-5', 'claude-fable-5-2', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1']);
  assert.ok(!models.includes('default') && !models.includes('opus'), 'aliases resolve to their ids, so your own default never decides');
  assert.equal(models.length, new Set(models).size);
});

test('claudeModels asks with initialize alone, so no model runs and no session is kept', async () => {
  const seen = [];
  await claudeModels('claude', { spawnImpl: /** @type {any} */ (fakeClaude(ANSWER, seen)) });
  assert.deepEqual(
    seen[0].written.map((m) => m.request?.subtype ?? m.type),
    ['initialize'],
  );
  assert.ok(seen[0].args.includes('--no-session-persistence'));
  assert.equal(seen[0].child.killed, true, 'the CLI is stopped once it has answered');
});

test('claudeModels is empty when the CLI exits without listing', async () => {
  const models = await claudeModels('claude', { spawnImpl: /** @type {any} */ (fakeClaude(null, [])) });
  assert.deepEqual(models, []);
});

test('claudeModels is empty when the CLI can’t start', async () => {
  const spawnImpl = () => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), kill: () => true });
    setImmediate(() => child.emit('error', Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' })));
    return child;
  };
  assert.deepEqual(await claudeModels('claude', { spawnImpl: /** @type {any} */ (spawnImpl) }), []);
});

test('sdkModels reads the SDK’s supportedModels, sends no message, and closes the query', async () => {
  const calls = { closed: false, sent: 0 };
  /** @type {Promise<void> | undefined} */
  let reading;
  const sdk = {
    query: ({ prompt }) => {
      reading = (async () => {
        for await (const _ of prompt) calls.sent++;
      })();
      return {
        supportedModels: async () => ROWS,
        close: () => {
          calls.closed = true;
        },
      };
    },
  };
  const models = await sdkModels(sdk);
  assert.equal(models[0], 'claude-opus-5-5');
  assert.ok(models.includes('claude-fable-5-2'));
  assert.equal(calls.closed, true);
  await reading; // the query’s input ends once it’s closed, so the SDK’s CLI isn’t left waiting for a message
  assert.equal(calls.sent, 0);
});

test('sdkModels is empty when the SDK can’t list', async () => {
  const sdk = { query: () => ({ supportedModels: async () => Promise.reject(new Error('not signed in')), close: () => {} }) };
  assert.deepEqual(await sdkModels(sdk), []);
});

test('claudeModels turns hooks off for the listing, so none of the person’s SessionStart hooks run', async () => {
  const seen = [];
  await claudeModels('claude', { spawnImpl: /** @type {any} */ (fakeClaude(ANSWER, seen)) });
  const at = seen[0].args.indexOf('--settings');
  assert.ok(at >= 0, 'settings of its own, over the person’s');
  assert.deepEqual(JSON.parse(seen[0].args[at + 1]), { disableAllHooks: true });
});
