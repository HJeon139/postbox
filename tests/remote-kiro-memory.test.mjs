// #479 on a remote host: Kiro keeps memory per Kiro home, in that home’s settings/cli.json, with no per-run flag or
// variable for it. An Isolated persona on a host runs with its own Kiro home under ~/.postbox-remote (start.env’s
// KIRO_HOME), so the daemon turns memory off there before each Kiro start, as kiro-cli.mjs does locally for the home
// Postbox owns. The host’s own Kiro home, used with your setup, is never written. Through the daemon in-process, with
// fake runners (tests/remote-cleanup-setup.mjs).

import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { daemonSetup, startMsg } from './remote-cleanup-setup.mjs';
import { tempDir } from './temp-dirs.mjs';

const kiro = (turn, env = {}) => startMsg(turn, { harness: 'kiro-cli', stdin: 'none', files: [], env, agentFile: { name: `pb-${turn}.json`, text: '{}' } });
const cliJson = (home) => join(home, 'settings', 'cli.json');

test('#479 daemon: an Isolated persona’s own Kiro home gets memory off before its turn, 0600, keeping its other settings', async () => {
  const s = daemonSetup();
  try {
    const c = await s.connect();
    const fresh = `${s.p.root}/kiro-home/coder`;
    c.send('start', kiro('t1', { KIRO_HOME: fresh }));
    await c.msgs.next('started');
    assert.deepEqual(JSON.parse(readFileSync(cliJson(fresh), 'utf8')), { 'memory.mode': 'disabled', 'memory.reflection': false });
    assert.equal(statSync(cliJson(fresh)).mode & 0o777, 0o600);
    // A home with settings of its own, memory on as Kiro’s default: the other keys stay.
    const used = `${s.p.root}/kiro-home/critic`;
    mkdirSync(join(used, 'settings'), { recursive: true });
    writeFileSync(cliJson(used), JSON.stringify({ 'chat.defaultModel': 'auto', 'memory.mode': 'read_write', 'memory.reflection': true }));
    c.send('start', kiro('t2', { KIRO_HOME: used }));
    await c.msgs.next('started');
    assert.deepEqual(JSON.parse(readFileSync(cliJson(used), 'utf8')), {
      'chat.defaultModel': 'auto',
      'memory.mode': 'disabled',
      'memory.reflection': false,
    });
  } finally {
    await s.done();
  }
});

test('#479 daemon: with your setup, no Kiro home’s settings are written, neither ~/.kiro nor the host’s KIRO_HOME', async () => {
  const s = daemonSetup();
  const t = daemonSetup({ env: {} });
  try {
    const c = await t.connect();
    c.send('start', kiro('t1'));
    await c.msgs.next('started');
    assert.ok(existsSync(join(t.home, '.kiro', 'agents', 'pb-t1.json')), 'the agent file was written');
    assert.deepEqual(readdirSync(join(t.home, '.kiro')), ['agents']);
    const own = join(s.home, 'kiro-own');
    s.env.KIRO_HOME = own;
    const d = await s.connect();
    d.send('start', kiro('t1'));
    await d.msgs.next('started');
    assert.deepEqual(readdirSync(own), ['agents']);
  } finally {
    await s.done();
    await t.done();
  }
});

test('#479 daemon: a home whose memory can’t be turned off fails the start, as an agent file that can’t be written does', async () => {
  const s = daemonSetup();
  try {
    const c = await s.connect();
    const home = `${s.p.root}/kiro-home/coder`;
    mkdirSync(join(home, 'settings'), { recursive: true });
    chmodSync(join(home, 'settings'), 0o500);
    c.send('start', kiro('t1', { KIRO_HOME: home }));
    const err = await c.msgs.next('error');
    chmodSync(join(home, 'settings'), 0o700);
    assert.equal(err.code, 'start-failed');
    assert.match(err.message, /Couldn’t start turn t1: Postbox couldn’t turn Kiro’s memory off in .*cli\.json/);
    assert.ok(!existsSync(s.p.turn('t1')), 'no turn folder');
    assert.ok(!existsSync(join(home, 'agents', 'pb-t1.json')), 'no agent file');
  } finally {
    await s.done();
  }
});

test('#479 daemon: a KIRO_HOME outside ~/.postbox-remote is refused, and nothing is written there', async () => {
  const s = daemonSetup();
  const outside = tempDir('pb-kiro-outside-');
  try {
    const c = await s.connect();
    c.send('start', kiro('t1', { KIRO_HOME: outside }));
    const err = await c.msgs.next('error');
    assert.equal(err.code, 'start-failed');
    assert.match(err.message, /KIRO_HOME .* isn’t under .*\.postbox-remote/);
    assert.deepEqual(readdirSync(outside), []);
  } finally {
    await s.done();
  }
});
