// What a refused Antigravity call says when agy runs without the PreToolUse hook (server/adapters/agy-refusals.mjs),
// and the confirmation gate that decides whether --dangerously-skip-permissions may be passed (#370).

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { agyHookCommand, agyHooksJson, agySupportsHooks, confirmAgyHook, HOOK_SCRIPT, HOOK_TIMEOUT_S } from '../server/adapters/agy-hook.mjs';
import { refusalFollowUp, refusalOf } from '../server/adapters/agy-refusals.mjs';
import { AntigravityCliAdapter, agyArgs, createAgyMapper, modeArgs, PLUGIN_DIR } from '../server/adapters/antigravity-cli.mjs';
import { CARD_WAIT_MS } from '../server/permission-cards.mjs';

const fixture = (name) =>
  readFileSync(new URL(`fixtures/antigravity-cli/${name}.jsonl`, import.meta.url), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));

/** A recorded turn replayed for a persona in the given mode; returns the steps it reported. */
function replay(name, permissionMode) {
  /** @type {any[]} */
  const activity = [];
  const ctx = {
    persona: { handle: 'gem', model: 'gemini-3.8-flash-high', permissionMode, tools: [] },
    state: {},
    saveState: () => {},
    text: () => {},
    activity: (/** @type {any} */ a) => activity.push(a),
    status: () => {},
    reported: () => {},
  };
  const m = createAgyMapper(ctx, { now: () => 1000 });
  for (const e of fixture(name)) m.push(e);
  return activity;
}

test('#370 each mode’s refusal says what it refuses and that Run everything allows it', () => {
  assert.match(
    refusalOf('ask'),
    /can’t ask you from Postbox, so it was refused\. In Ask me, it refuses every edit and command it would ask about\. Run everything allows it\.$/,
  );
  assert.match(refusalOf('acceptEdits'), /In Accept edits, it refuses every command it would ask about\. Run everything allows it\.$/);
  assert.match(refusalOf('auto'), /In Auto, its safety check refused it, or your account doesn’t offer auto mode, so it ran as Ask me\./);
  // A persona from before modes reads as Auto, Postbox’s default.
  assert.equal(refusalOf(undefined), refusalOf('auto'));
});

test('#370 a recorded refusal shows its persona’s mode on the denied step', () => {
  // Refused with the step marked (agy 1.4.5), for a persona in Ask me.
  assert.match(replay('refused', 'ask').at(-1).detail, /In Ask me,/);
  // Recorded with --mode auto on an account without it: only the result’s denied_actions said it was refused.
  const auto = replay('auto-unavailable', 'auto').find((a) => a.state === 'denied');
  assert.match(auto.detail, /In Auto, .* so it ran as Ask me\. Run everything allows it\.$/);
});

test('#370 the follow-up asks the agent to say that Run everything would allow the call', () => {
  assert.match(refusalFollowUp('Ran ls -la'), /that your permission mode in Postbox didn’t allow it, and that Run everything would/);
});

test('#370 condition 1: --dangerously-skip-permissions is passed for ask, auto and acceptEdits only when the hook is confirmed', async () => {
  assert.equal(HOOK_TIMEOUT_S, Math.ceil(CARD_WAIT_MS / 1000) + 60);
  for (const v of ['1.4.5', '1.4.7', '1.5.0', '2.0.0']) assert.equal(agySupportsHooks(v), true, v);
  for (const v of ['1.4.4', '1.3.9', '0.9.0', 'unknown', null, undefined, '']) assert.equal(agySupportsHooks(v), false, String(v));
  assert.equal(agyHookCommand('/opt/postbox/server/adapters/agy-hook.mjs'), '/opt/postbox/server/adapters/agy-hook.mjs');
  for (const bad of ['/path with spaces/agy-hook.mjs', '/path/"quote"/hook.mjs', '/path/$var/hook.mjs', 'relative/hook.mjs', ''])
    assert.equal(agyHookCommand(bad), null, bad);
  assert.deepEqual(modeArgs({ permissionMode: 'ask' }), []);
  assert.deepEqual(modeArgs({ permissionMode: 'auto' }), ['--mode', 'auto']);
  assert.deepEqual(modeArgs({ permissionMode: 'acceptEdits' }), ['--mode', 'accept-edits']);
  assert.deepEqual(modeArgs({ permissionMode: 'bypass' }), ['--dangerously-skip-permissions']);
  for (const m of ['ask', 'auto', 'acceptEdits', 'bypass']) {
    assert.deepEqual(modeArgs({ permissionMode: m }, { hookConfirmed: true }), ['--dangerously-skip-permissions']);
    const args = agyArgs({ persona: { permissionMode: m }, model: 'gemini-3.8-flash-high', effort: null, prompt: 'hi', hookConfirmed: true });
    assert.ok(args.includes('--dangerously-skip-permissions'), m);
  }
  const dir = mkdtempSync(join(tmpdir(), 'pb-agy-confirm-'));
  writeFileSync(join(dir, 'hooks.json'), `${JSON.stringify(agyHooksJson(HOOK_SCRIPT, HOOK_TIMEOUT_S), null, 2)}\n`);
  assert.equal(await confirmAgyHook({ version: '1.4.7', pluginDir: dir }), true);
  assert.equal(await confirmAgyHook({ version: '1.4.4', pluginDir: dir }), false);
  assert.equal(await confirmAgyHook({ version: '1.4.7', pluginDir: dir, script: join(dir, 'missing.mjs') }), false);
  assert.equal(await confirmAgyHook({ version: '1.4.7', pluginDir: dir, script: '/bad path/hook.mjs' }), false);
  writeFileSync(join(dir, 'hooks.json'), '{}');
  assert.equal(await confirmAgyHook({ version: '1.4.7', pluginDir: dir }), false);
});

async function runDeliverTurn(permissionMode, opts = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pb-agy-turn-'));
  /** @type {any[]} */
  const seen = [];
  const spawnImpl = (_bin, args, spOpts) => {
    const hooksFile = join(spOpts.cwd, PLUGIN_DIR, 'hooks.json');
    seen.push({
      args,
      env: spOpts.env,
      hasHooks: existsSync(hooksFile),
      hooksMode: existsSync(hooksFile) ? statSync(hooksFile).mode & 0o777 : null,
    });
    const child = new EventEmitter();
    Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => {} });
    setImmediate(() => {
      for (const e of fixture('first')) child.stdout.write(`${JSON.stringify(e)}\n`);
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
    ...opts,
  });
  const abort = new AbortController();
  const persona = { handle: 'gem', model: 'gemini-3.8-flash-high', permissionMode, tools: [] };
  const nop = () => {};
  const ctx = {
    signal: abort.signal,
    mcpUrl: 'http://127.0.0.1:4280/mcp?session=se_1&token=t1',
    persona,
    project: null,
    handles: ['gem'],
    state: {},
    saveState: nop,
    pathOf: () => null,
    text: nop,
    activity: nop,
    status: nop,
    reported: nop,
  };
  await adapter.deliver({}, { kind: 'user', text: 'hi' }, ctx);
  return seen[0];
}

test('#370 condition 1: AntigravityCliAdapter writes read-only hooks.json and falls back to mode flags when unconfirmed', async () => {
  const confirmed = await runDeliverTurn('auto', { version: '1.4.7' });
  assert.equal(confirmed.hasHooks, true);
  assert.equal(confirmed.hooksMode, 0o444, 'hooks.json is read-only during the turn');
  assert.ok(confirmed.args.includes('--dangerously-skip-permissions'));
  assert.equal(confirmed.env.POSTBOX_AGY_MODE, 'auto');
  assert.equal(confirmed.env.POSTBOX_MCP_URL, 'http://127.0.0.1:4280/mcp?session=se_1&token=t1');

  const oldVer = await runDeliverTurn('auto', { version: '1.4.4' });
  assert.equal(oldVer.hasHooks, false);
  assert.ok(!oldVer.args.includes('--dangerously-skip-permissions'));
  assert.deepEqual(oldVer.args.slice(oldVer.args.indexOf('--mode'), oldVer.args.indexOf('--mode') + 2), ['--mode', 'auto']);

  const missingScript = await runDeliverTurn('acceptEdits', { version: '1.4.7', hookScript: '/nonexistent/agy-hook.mjs' });
  assert.ok(!missingScript.args.includes('--dangerously-skip-permissions'));
  assert.deepEqual(missingScript.args.slice(missingScript.args.indexOf('--mode'), missingScript.args.indexOf('--mode') + 2), ['--mode', 'accept-edits']);
});
