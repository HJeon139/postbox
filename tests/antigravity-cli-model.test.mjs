// The model an Antigravity CLI turn names when its persona names Postbox’s default, Claude’s, which agy doesn’t run:
// Gemini’s default while agy lists it, else the first model agy listed (agyModel), read from what the backend offers
// now, which server/model-lists.mjs updates when the model field asks agy.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { AntigravityCliAdapter } from '../server/adapters/antigravity-cli.mjs';
import { DEFAULT_MODEL } from '../server/adapters/setup.mjs';
import { fakeCtx } from './kiro-cli-fakes.mjs';
import { tempDir } from './temp-dirs.mjs';

// A turn recorded from agy 1.4.5 (tests/fixtures/antigravity-cli/first.jsonl).
const FIRST = readFileSync(new URL('./fixtures/antigravity-cli/first.jsonl', import.meta.url), 'utf8');

/** The --model a turn passed, on an adapter that offers models. */
async function modelPassed(models) {
  const root = tempDir('pb-agy-model-');
  const seen = [];
  const spawnImpl = (_bin, args) => {
    seen.push(args);
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
    setImmediate(() => {
      child.stdout.end(FIRST);
      child.stderr.end();
      setImmediate(() => child.emit('close', 0));
    });
    return child;
  };
  const adapter = new AntigravityCliAdapter({
    workRoot: join(root, 'work'),
    settingsFile: join(root, 'settings.json'),
    spawnImpl: /** @type {any} */ (spawnImpl),
    env: {},
  });
  // As server/model-lists.mjs offers a list agy gave.
  adapter.capabilities = { ...adapter.capabilities, models };
  const ctx = fakeCtx({ persona: { handle: 'gem', model: DEFAULT_MODEL, permissionMode: 'ask', tools: [], description: '', instructions: '' } });
  await adapter.deliver({}, { kind: 'user', text: 'hi' }, ctx);
  return seen[0][seen[0].indexOf('--model') + 1];
}

test('a persona on Claude’s default runs the first model agy listed when agy no longer lists Gemini’s default', async () => {
  assert.equal(await modelPassed(['gemini-4-argon-medium', 'gemini-4-argon-high']), 'gemini-4-argon-medium');
});

test('a persona on Claude’s default runs Gemini’s default while agy lists it', async () => {
  assert.equal(await modelPassed(['gemini-4-argon-medium', 'gemini-3.8-flash-high']), 'gemini-3.8-flash-high');
});
