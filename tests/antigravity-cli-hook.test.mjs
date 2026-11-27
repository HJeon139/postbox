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
 * @param {{ version?: string, hookScript?: string, hookProbe?: () => Promise<boolean>, runs?: string[], state?: any, onSpawn?: (cwd: string) => void }} [o]
 */
async function turn(persona, { version = '1.4.7', hookScript, hookProbe = async () => true, runs: fixtures = ['first'], state = {}, onSpawn = () => {} } = {}) {
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
    hookProbe,
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
  return { error, spawned, left, root };
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

test('the follow-up after a refusal checks the hook again, and stops when it no longer holds', async () => {
  // The recorded refusal’s own conversation, so the follow-up resumes it.
  const state = () => ({ agySessionId: 'ecb9ae82-d2c0-49dc-ac0d-638934ef0cb8' });
  const held = await turn({ permissionMode: 'bypass' }, { state: state(), runs: ['refused', 'first'] });
  assert.equal(held.error, null);
  assert.equal(held.spawned.length, 2, 'with the hook intact, the follow-up runs');
  const changed = await turn({ permissionMode: 'bypass' }, { onSpawn: tamper, state: state(), runs: ['refused', 'first'] });
  assert.match(String(changed.error?.message), OPTIONS);
  assert.equal(changed.spawned.length, 1, 'the follow-up didn’t start');
  assert.deepEqual(changed.left, ['gem']);
});

// PR #1515’s second review: a hook whose import broke passed the check. The check runs it (the probe, run for real in
// tests/process/agy-hook-command.test.mjs), and a hook that doesn’t refuse a web search isn’t confirmed.
test('a hook that doesn’t answer stops Run everything with Web off, and other modes run in agy’s own mode', async () => {
  const silent = async () => false;
  const bypass = await turn({ permissionMode: 'bypass' }, { hookProbe: silent });
  assert.match(String(bypass.error?.message), OPTIONS);
  assert.equal(bypass.spawned.length, 0);
  assert.deepEqual(bypass.left, ['gem']);
  const auto = await turn({ permissionMode: 'auto' }, { hookProbe: silent });
  assert.equal(auto.error, null);
  assert.ok(!auto.spawned[0].includes('--dangerously-skip-permissions'));
  // The probe runs before each run of the turn, so a hook broken during the first stops the restart.
  let runs = 0;
  const breaks = async () => ++runs === 1;
  const state = { agySessionId: '00000000-0000-0000-0000-000000000000' };
  const restart = await turn({ permissionMode: 'bypass' }, { hookProbe: breaks, state, runs: ['missing-session', 'first'] });
  assert.match(String(restart.error?.message), OPTIONS);
  assert.equal(restart.spawned.length, 1);
});

// #314: a turn notes its plugin beside the work root while agy runs, so a Postbox killed then removes it as it starts
// again (agy-plugin-record.mjs), and drops the note once it has removed the plugin itself.
test('#314 a turn’s plugin is noted beside the work root while agy runs, and dropped once removed', async () => {
  /** @type {unknown} */
  let during = null;
  const { error, root } = await turn(
    {},
    {
      onSpawn: (cwd) => {
        during = JSON.parse(readFileSync(join(cwd, '..', '..', 'agy-plugins.json'), 'utf8'));
      },
    },
  );
  assert.equal(error, null);
  assert.equal(Array.isArray(during) && during.length, 1, 'noted while agy runs');
  assert.ok(String(/** @type {any[]} */ (during)[0].dir).endsWith(PLUGIN_DIR), 'the plugin’s own folder');
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'agy-plugins.json'), 'utf8')), [], 'and dropped once the turn removed it');
});
