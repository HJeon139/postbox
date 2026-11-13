// The host daemon’s `models` (server/remote/host/daemon-models.mjs, #1304), in-process with a fake spawn
// (tests/remote-daemon-setup.mjs) that answers as the CLIs did: Claude Code 2.1.318’s initialize and Codex
// app-server’s model/list, recorded with the account and path fields left out.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { hello, setup, until } from './remote-daemon-setup.mjs';

const recorded = (path) =>
  readFileSync(new URL(`./fixtures/${path}`, import.meta.url), 'utf8')
    .trim()
    .split('\n');
/** Each recorded answer, by the request it answers: Claude’s by request_id, Codex’s by id. */
const ANSWERS = new Map([
  ...recorded('claude-code/initialize-models.jsonl').map((l) => [JSON.parse(l).response.request_id, l]),
  ...recorded('codex-app-server/model-list.jsonl').map((l) => [JSON.parse(l).id, l]),
]);

/** A spawn whose children answer each JSON request with the recorded line for it, or exit at once when mute. */
function cliSpawn({ mute = false } = {}) {
  const calls = [];
  const spawn = (program, args, options) => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough() });
    child.kill = () => {
      setImmediate(() => child.emit('close', null));
      return true;
    };
    calls.push({ program, args, options });
    child.stdin.on('data', (d) => {
      if (mute) return void setImmediate(() => child.emit('close', 1));
      for (const line of String(d).trim().split('\n')) {
        const ask = JSON.parse(line);
        const answer = ANSWERS.get(ask.request_id ?? ask.id);
        if (answer) child.stdout.write(`${answer}\n`);
      }
    });
    return child;
  };
  return { spawn, calls };
}

test('models: the host’s own claude lists them, run as an argument list in the home folder with the login shell’s PATH', async () => {
  const sp = cliSpawn();
  const s = setup({ spawn: sp.spawn, probeLoginPath: async () => ({ ok: true, entries: ['/opt/tools/bin', '/usr/bin'], ms: 5 }) });
  try {
    const c = await hello(s);
    c.send('models', { harness: 'claude-code' });
    const listed = await c.msgs.next('listed');
    assert.equal(listed.harness, 'claude-code');
    assert.deepEqual(listed.models.slice(0, 3), ['claude-opus-5-5', 'claude-fable-5-2', 'claude-sonnet-5-5']);
    const [call] = sp.calls;
    assert.equal(call.program, '/home/user/.local/bin/claude', 'the program the welcome reported');
    assert.ok(call.args.includes('--no-session-persistence'));
    assert.equal(call.options.shell, false);
    assert.equal(call.options.cwd, s.home);
    assert.equal(call.options.env.PATH.split(':')[0], '/opt/tools/bin', call.options.env.PATH);
  } finally {
    await s.done();
  }
});

test('models: Codex’s list comes with its harness named, and auto isn’t added on the host', async () => {
  const sp = cliSpawn();
  const s = setup({ spawn: sp.spawn });
  try {
    const c = await hello(s);
    c.send('models', { harness: 'codex' });
    const listed = await c.msgs.next('listed');
    assert.equal(listed.harness, 'codex');
    assert.equal(listed.models[0], 'gpt-6.1-sol');
    assert.ok(!listed.models.includes('auto'), 'the laptop’s Codex adapter adds its own default');
    assert.equal(sp.calls[0].program, '/home/user/.local/bin/codex');
  } finally {
    await s.done();
  }
});

test('models: a harness the host doesn’t have is answered with none, and nothing runs', async () => {
  const sp = cliSpawn();
  const s = setup({ spawn: sp.spawn });
  try {
    const c = await hello(s);
    c.send('models', { harness: 'kiro-cli' });
    assert.deepEqual(await c.msgs.next('listed'), { type: 'listed', harness: 'kiro-cli', models: [] });
    assert.equal(sp.calls.length, 0);
  } finally {
    await s.done();
  }
});

test('models: a CLI that exits without listing is answered with none, and other messages go on meanwhile', async () => {
  const sp = cliSpawn({ mute: true });
  const s = setup({ spawn: sp.spawn });
  try {
    const c = await hello(s);
    c.send('models', { harness: 'claude-code' });
    await until(() => sp.calls.length === 1, 'the listing to start');
    c.send('read', { turn: 'nope', from: 0 });
    assert.equal((await c.msgs.next('error')).code, 'no-turn');
    assert.deepEqual((await c.msgs.next('listed')).models, []);
  } finally {
    await s.done();
  }
});

test('models: a listing still running when the daemon closes is killed with it', async () => {
  const kills = [];
  let started = 0;
  const spawn = () => {
    started++;
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough() });
    child.kill = (signal) => kills.push(signal) && true; // never answers, never closes
    return child;
  };
  const s = setup({ spawn });
  const c = await hello(s);
  c.send('models', { harness: 'codex' });
  await until(() => started === 1, 'the listing to start');
  await s.done();
  assert.deepEqual(kills, ['SIGKILL']);
});
