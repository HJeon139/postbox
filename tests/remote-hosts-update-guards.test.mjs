// The automatic install’s guards that critic asked for (#464-b2a): forget() takes the host’s record with its token, so
// a later host with the same ID starts with no consent; every write to one host’s record goes through one chain, so
// the consent’s write and an install’s don’t overwrite each other; and an install’s ssh stops when its signal fires.
// ssh is never run: tests/fake-ssh.mjs’s children answer.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { installHost, tokenFile } from '../server/remote/install.mjs';
import { changeRecord, recordOf } from '../server/remote/install-record.mjs';
import { FAKE_TOKEN } from './fake-daemon.mjs';
import { fakeSsh } from './fake-ssh.mjs';
import { sleep, until, VERSION } from './remote-hosts-fixtures.mjs';
import { hangs, readRecord, recordFile, rig } from './remote-hosts-update-fixtures.mjs';
import { HOST } from './remote-install-fixtures.mjs';

const settle = () => sleep(40);

test('#464-b2a: forget() removes the host’s record with its token, so a later host with the same ID has no consent', async () => {
  const t = rig();
  try {
    await t.mgr.setKeepUpdated('h1', true);
    assert.equal(t.mgr.status('h1').keepUpdated, true);
    await t.mgr.forget('h1');
    assert.equal(existsSync(recordFile(t.dataDir)), false, 'no record file');
    assert.equal(t.mgr.status('h1').keepUpdated, false, 'nor a record kept in memory');
    // A host made later with the same ID, installed by hand: its 127 installs nothing by itself.
    mkdirSync(join(t.dataDir, 'remote-tokens'), { recursive: true, mode: 0o700 });
    writeFileSync(tokenFile(t.dataDir, 'h1'), `${FAKE_TOKEN}\n`, { mode: 0o600 });
    await t.mgr.connect('h1').catch(() => {});
    await settle();
    assert.equal(t.runs.length, 0);
  } finally {
    t.done();
  }
});

test('#464-b2a: the consent turned off during an automatic install stays off after the install’s last write', async () => {
  const t = rig({ install: hangs });
  try {
    await t.mgr.setKeepUpdated('h1', true);
    await t.mgr.connect('h1').catch(() => {});
    await until(() => t.runs.length === 1, 'the install started');
    await t.mgr.setKeepUpdated('h1', false);
    t.runs[0].answer();
    await until(() => readRecord(t.dataDir)?.installs?.[0]?.outcome === 'installed', 'installed');
    await settle();
    assert.equal(readRecord(t.dataDir).keepUpdated, false, 'the install’s write kept the consent’s');
    assert.equal(t.mgr.status('h1').keepUpdated, false);
  } finally {
    t.done();
  }
});

test('#464-b2a: two writes to one host’s record in the same tick both land, in order', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'pbr-'));
  const m = { dataDir, installRecords: new Map(), recordWrites: new Map() };
  try {
    const entry = { version: VERSION, at: 1, outcome: 'installed' };
    const consent = changeRecord(m, 'h1', (was) => ({ keepUpdated: true, installs: was.installs }));
    const install = changeRecord(m, 'h1', (was) => ({ keepUpdated: was.keepUpdated, installs: [entry, ...was.installs] }));
    await Promise.all([consent, install]);
    assert.deepEqual(readRecord(dataDir), { keepUpdated: true, installs: [entry] });
    assert.deepEqual(recordOf(m, 'h1'), { keepUpdated: true, installs: [entry] });
    assert.equal(m.recordWrites.size, 0, 'the chain is dropped once its last write settles');
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('#464-b2a: installHost’s signal kills its ssh child with SIGKILL, and one fired first spawns nothing', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'pbi-'));
  const ssh = fakeSsh({ script: () => {} });
  try {
    const abort = new AbortController();
    const running = installHost({ host: HOST, version: VERSION, dataDir, spawn: ssh.spawn, signal: abort.signal }).then(
      () => assert.fail('it installed'),
      (e) => e,
    );
    await until(() => ssh.children.length === 1, 'ssh started');
    abort.abort();
    const e = await running;
    assert.equal(e.name, 'SshFailure');
    assert.match(e.message, /closed before the install finished/);
    assert.deepEqual(ssh.children[0].kills, ['SIGKILL']);
    const early = await installHost({ host: HOST, version: VERSION, dataDir, spawn: ssh.spawn, signal: abort.signal }).catch((x) => x);
    assert.equal(early.name, 'SshFailure');
    assert.equal(ssh.children.length, 1, 'nothing more was spawned');
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
