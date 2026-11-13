// Each real adapter’s listModels() (server/model-lists.mjs asks it when a model field opens): it runs its own CLI
// through the adapter’s spawn, and answers the ids the CLI listed. The CLIs’ answers are recorded: Claude Code
// 2.1.318’s initialize, `kiro-cli chat --list-models --format json`, `agy models`, and Codex app-server’s model/list,
// with the account and path fields left out.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { AntigravityCliAdapter } from '../server/adapters/antigravity-cli.mjs';
import { ClaudeCodeAdapter } from '../server/adapters/claude-code.mjs';
import { CodexAdapter } from '../server/adapters/codex.mjs';
import { KiroCliAdapter } from '../server/adapters/kiro-cli.mjs';
import { tempDir } from './temp-dirs.mjs';

const recorded = (path) => readFileSync(new URL(`./fixtures/${path}`, import.meta.url), 'utf8');
const workRoot = tempDir('pb-list-models-');

/** A child process: stdin, stdout and a kill that ends it. */
function child() {
  const c = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  c.kill = () => {
    setImmediate(() => c.emit('close', null));
    return true;
  };
  return c;
}

/** A CLI that prints out and exits with code, as `kiro-cli chat --list-models` and `agy models` do. */
const printing =
  (out, code = 0, seen = []) =>
  (_bin, args) => {
    seen.push(args);
    const c = child();
    setImmediate(() => {
      c.stdout.end(out);
      setImmediate(() => c.emit('close', code));
    });
    return c;
  };

/** A CLI that answers each JSON request on stdin with the recorded line for its id (Codex) or request id (Claude). */
const answering = (lines, idOf) => () => {
  const c = child();
  const byId = new Map(lines.map((l) => [idOf(JSON.parse(l)), l]));
  c.stdin.on('data', (d) => {
    for (const line of String(d).trim().split('\n')) {
      const answer = byId.get(JSON.parse(line).id ?? JSON.parse(line).request_id);
      if (answer) c.stdout.write(`${answer}\n`);
    }
  });
  return c;
};

test('Claude Code lists its models through its own spawn', async () => {
  const line = recorded('claude-code/initialize-models.jsonl').trim();
  const adapter = new ClaudeCodeAdapter({ bin: 'claude', workRoot, spawnImpl: /** @type {any} */ (answering([line], (m) => m.response.request_id)) });
  const models = await adapter.listModels();
  assert.deepEqual(models.slice(0, 3), ['claude-opus-5-5', 'claude-fable-5-2', 'claude-sonnet-5-5']);
});

test('Kiro lists its models through its own spawn, in Postbox’s spelling', async () => {
  const seen = [];
  const adapter = new KiroCliAdapter({
    bin: 'kiro-cli',
    workRoot,
    isolatedHome: workRoot,
    spawnImpl: /** @type {any} */ (printing(recorded('kiro-cli/list-models.json'), 0, seen)),
  });
  const models = await adapter.listModels();
  assert.deepEqual(seen, [['chat', '--list-models', '--format', 'json']]);
  assert.equal(models[0], 'auto');
  assert.ok(models.includes('claude-sonnet-4-5'), 'claude-sonnet-4.5 as Postbox spells it');
});

test('the Antigravity CLI lists its models through its own spawn', async () => {
  const seen = [];
  const adapter = new AntigravityCliAdapter({
    bin: 'agy',
    workRoot,
    settingsFile: `${workRoot}/agy.json`,
    spawnImpl: /** @type {any} */ (printing(recorded('antigravity-cli/models.txt'), 0, seen)),
  });
  const models = await adapter.listModels();
  assert.deepEqual(seen, [['models']]);
  assert.deepEqual(models.slice(0, 2), ['gemini-4-argon-medium', 'gemini-4-argon-high']);
});

test('Codex lists its models through its own spawn, with auto, its own default, beside them', async () => {
  const lines = recorded('codex-app-server/model-list.jsonl').trim().split('\n');
  const adapter = new CodexAdapter({ bin: 'codex', workRoot, spawnImpl: /** @type {any} */ (answering(lines, (m) => m.id)) });
  const models = await adapter.listModels();
  assert.equal(models[0], 'gpt-6.1-sol');
  assert.equal(models.at(-1), 'auto');
  assert.equal(models.filter((m) => m === 'auto').length, 1);
});

test('a CLI that fails to list gives no models, so the field keeps the last list', async () => {
  const failing = /** @type {any} */ (printing('Error: Please sign in to view available models.\n', 1));
  assert.deepEqual(await new KiroCliAdapter({ bin: 'kiro-cli', workRoot, isolatedHome: workRoot, spawnImpl: failing }).listModels(), []);
  assert.deepEqual(await new AntigravityCliAdapter({ bin: 'agy', workRoot, settingsFile: `${workRoot}/agy.json`, spawnImpl: failing }).listModels(), []);
  const silent = /** @type {any} */ (
    () => {
      const c = child();
      setImmediate(() => c.emit('error', Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' })));
      return c;
    }
  );
  assert.deepEqual(await new CodexAdapter({ bin: 'codex', workRoot, spawnImpl: silent }).listModels(), [], 'not auto alone: that would read as a list');
});
