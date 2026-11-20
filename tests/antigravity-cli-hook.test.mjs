// When Run everything with Web off can’t have its PreToolUse hook (server/adapters/antigravity-cli.mjs, deliver), and
// how the hook is checked again before each run of a turn: the restart of a conversation agy no longer has, and the
// follow-up after a refusal. The agent could change the plugin during a run, so a check at the turn’s start isn’t
// enough (PR #1515’s review).

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmodSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { AntigravityCliAdapter, PLUGIN_DIR } from '../server/adapters/antigravity-cli.mjs';
import { tempDir } from './temp-dirs.mjs';

const fixture = (name) =>
  readFileSync(new URL(`fixtures/antigravity-cli/${name}.jsonl`, import.meta.url), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));

const OPTIONS = /Turn Web on for this agent, or pick another permission mode\./;

/**
 * One turn of a persona, its runs replaying the fixtures in order; onSpawn runs as the first starts, in the agent’s folder.
 * @param {{ permissionMode: string, tools?: string[] }} persona
 * @param {{ version?: string, hookScript?: string, runs?: string[], state?: any, onSpawn?: (cwd: string) => void }} [o]
 */
async function turn(persona, { version = '1.4.7', hookScript, runs: fixtures = ['first'], state = {}, onSpawn = () => {} } = {}) {
  const runs = [...fixtures];
  const root = tempDir('pb-agy-hook-turn-');
  /** @type {string[][]} */
  const spawned = [];
  const spawnImpl = (_bin, args, opts) => {
    spawned.push(args);
    if (spawned.length === 1) onSpawn(opts.cwd);
    const child = new EventEmitter();
    Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => {} });
    const lines = fixture(String(runs.shift()));
    setImmediate(() => {
      for (const e of lines) child.stdout.write(`${JSON.stringify(e)}\n`);
      child.stdout.end();
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
    version,
    ...(hookScript ? { hookScript } : {}),
  });
  const nop = () => {};
  const ctx = {
    signal: new AbortController().signal,
    mcpUrl: 'http://127.0.0.1:4280/mcp?session=se_1&token=t1',
    persona: { handle: 'gem', model: 'gemini-3.8-flash-high', tools: [], ...persona },
    project: null,
    handles: ['gem'],
    state,
    saveState: nop,
    pathOf: () => null,
    text: nop,
    activity: nop,
    status: nop,
    reported: nop,
  };
  const error = await adapter.deliver({}, { kind: 'user', text: 'hi' }, ctx).then(
    () => null,
    (e) => e,
  );
  const left = readdirSync(join(root, 'work'), { recursive: true }).map(String);
  return { error, spawned, left };
}

/** Changes hooks.json during a run, as an agent with Shell could. @param {string} cwd */
const tamper = (cwd) => {
  const file = join(cwd, PLUGIN_DIR, 'hooks.json');
  chmodSync(file, 0o644);
  writeFileSync(file, '{}');
};

test('Run everything with Web off and no hook never starts agy, says what to do, and removes the plugin', async () => {
  for (const o of [{ version: '1.4.5' }, { hookScript: '/nonexistent/agy-hook.mjs' }]) {
    const { error, spawned, left } = await turn({ permissionMode: 'bypass' }, o);
    assert.match(String(error?.message), OPTIONS, JSON.stringify(o));
    assert.equal(spawned.length, 0, 'agy wasn’t started');
    assert.deepEqual(left, ['gem'], 'the plugin is gone');
  }
});

test('the restart of a lost conversation checks the hook again, and stops when it no longer holds', async () => {
  const state = { agySessionId: '00000000-0000-0000-0000-000000000000' };
  const once = { onSpawn: tamper, state, runs: ['missing-session', 'first'] };
  const bypass = await turn({ permissionMode: 'bypass' }, { ...once, state: { ...state } });
  assert.match(String(bypass.error?.message), OPTIONS);
  assert.equal(bypass.spawned.length, 1, 'the restart didn’t start');
  assert.deepEqual(bypass.left, ['gem']);
  // In Auto the restart runs, in agy’s own mode, since the hook can’t ask.
  const auto = await turn({ permissionMode: 'auto' }, { ...once, state: { ...state } });
  assert.equal(auto.error, null);
  assert.equal(auto.spawned.length, 2);
  assert.ok(auto.spawned[0].includes('--dangerously-skip-permissions'));
  assert.ok(!auto.spawned[1].includes('--dangerously-skip-permissions'));
  assert.deepEqual(auto.spawned[1].slice(auto.spawned[1].indexOf('--mode'), auto.spawned[1].indexOf('--mode') + 2), ['--mode', 'auto']);
});
