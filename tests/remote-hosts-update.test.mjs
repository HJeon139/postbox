// The automatic install (server/remote/hosts-update.mjs, #464-b2a; designs/464-keep-updated.md): with the person’s
// standing consent for a host, a 127 from its launcher (this version isn’t there) installs this Postbox’s version once,
// in the failure’s own tick, and nothing else does. The record’s strict read and “tried” are in
// remote-hosts-update-record.test.mjs; one install at a time, exit 75, close() and forget() in
// remote-hosts-update-run.test.mjs. ssh is never run: tests/remote-hosts-update-fixtures.mjs’s fake answers.

import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { classifyExit, failure as sshFailure } from '../server/remote/ssh.mjs';
import { classifyRefusal } from '../server/remote/ssh-failures.mjs';
import { sleep, until, VERSION } from './remote-hosts-fixtures.mjs';
import { hangs, NOT_INSTALLED, readRecord, rig, writeRecord } from './remote-hosts-update-fixtures.mjs';

/** A 127 as ssh reports it for this host, to emit on a link. */
const f127 = () => classifyExit({ destination: 'host.example.com', code: 127, signal: null, stderr: NOT_INSTALLED });
/** Lets the install, its record writes and the reconnect after it run. */
const settle = () => sleep(40);

test('#464-b2a: a 127 with the consent on and a token here installs once, and the record says installed for this version', async () => {
  const t = rig();
  try {
    await t.mgr.setKeepUpdated('h1', true);
    const f = await t.mgr.connect('h1').catch((e) => e);
    assert.equal(f.kind, 'not-installed');
    assert.equal(f.detail.code, 127);
    await until(() => readRecord(t.dataDir)?.installs?.[0]?.outcome === 'installed', 'the record says installed');
    await settle();
    assert.equal(t.runs.length, 1, 'the fake ssh saw the install command once');
    const rec = readRecord(t.dataDir);
    assert.equal(rec.keepUpdated, true);
    assert.equal(rec.installs.length, 1, 'the started entry is rewritten, not added to');
    assert.equal(rec.installs[0].version, VERSION);
    assert.equal(typeof rec.installs[0].at, 'number');
    const st = t.mgr.status('h1');
    assert.equal(st.keepUpdated, true);
    assert.equal(st.update.version, VERSION);
    assert.equal(st.update.outcome, 'installed');
  } finally {
    t.done();
  }
});

test('#464-b2a: m.updating has the host in the failure’s own tick, before any other failure listener of the link runs', async () => {
  const t = rig({ install: hangs });
  try {
    await t.mgr.setKeepUpdated('h1', true);
    const l = t.mgr.link('h1');
    /** @type {unknown} */
    let seen = 'never ran';
    l.on('failure', () => {
      seen = t.mgr.updating?.has('h1') ?? 'the manager has no updating map';
    });
    await t.mgr.connect('h1').catch(() => {});
    assert.equal(seen, true, 'the follow listener set m.updating synchronously');
    await until(() => t.runs.length === 1, 'the install started');
    t.runs[0].answer();
    await until(() => !t.mgr.updating.has('h1'), 'the entry is deleted once it settles');
  } finally {
    t.done();
  }
});

test('#464-b2a: no install with the consent off', async () => {
  const t = rig();
  try {
    await t.mgr.setKeepUpdated('h1', false);
    await t.mgr.connect('h1').catch(() => {});
    await settle();
    assert.equal(t.runs.length, 0);
    assert.equal(readRecord(t.dataDir).keepUpdated, false);
    assert.equal(t.mgr.status('h1').keepUpdated, false);
  } finally {
    t.done();
  }
});

test('#464-b2a: no install with no record file, which is no consent', async () => {
  const t = rig();
  try {
    await t.mgr.connect('h1').catch(() => {});
    await settle();
    assert.equal(t.runs.length, 0);
    assert.equal(readRecord(t.dataDir), null, 'nothing wrote a record');
    assert.equal(t.mgr.status('h1').keepUpdated, false);
  } finally {
    t.done();
  }
});

test('#464-b2a: no install for a link whose token this computer no longer has', async () => {
  const t = rig();
  try {
    const l = t.mgr.link('h1');
    await t.mgr.forget('h1');
    // The host is still configured, with the consent on, but its token here is gone.
    await t.mgr.setKeepUpdated('h1', true);
    l.emit('failure', f127());
    await settle();
    assert.equal(t.runs.length, 0);
    assert.equal(t.mgr.updating.has('h1'), false);
  } finally {
    t.done();
  }
});

test('#464-b2a: no install for a 126, a launcher that’s there but couldn’t run', async () => {
  const t = rig({ attach: '126' });
  try {
    await t.mgr.setKeepUpdated('h1', true);
    const f = await t.mgr.connect('h1').catch((e) => e);
    assert.equal(f.kind, 'could-not-start');
    await settle();
    assert.equal(t.runs.length, 0);
    assert.equal(t.mgr.status('h1').keepUpdated, true);
  } finally {
    t.done();
  }
});

test('#464-b2a: no install for a version failure, the daemon refusing this Postbox’s version', async () => {
  const t = rig();
  try {
    await t.mgr.setKeepUpdated('h1', true);
    t.mgr.link('h1').emit('failure', classifyRefusal('host.example.com', { code: 'version', message: 'This daemon speaks protocol 2.' }));
    await settle();
    assert.equal(t.runs.length, 0);
    assert.equal(t.mgr.updating.has('h1'), false);
  } finally {
    t.done();
  }
});

test('#464-b2a: no install for the synthetic “no token here” not-installed, which has no exit code', async () => {
  const t = rig();
  try {
    await t.mgr.setKeepUpdated('h1', true);
    const synthetic = Object.assign(sshFailure('not-installed', 'host.example.com', { why: 'This Postbox has no token for it.' }), { code: 'not-installed' });
    assert.equal(synthetic.detail.code, undefined);
    t.mgr.link('h1').emit('failure', synthetic);
    await settle();
    assert.equal(t.runs.length, 0);
    assert.equal(t.mgr.updating.has('h1'), false);
  } finally {
    t.done();
  }
});

test('#464-b2a: no install for a host removed before its link’s 127 arrives', async () => {
  const t = rig();
  try {
    await t.mgr.setKeepUpdated('h1', true);
    const l = t.mgr.link('h1');
    delete t.hosts.h1;
    l.emit('failure', f127());
    await settle();
    assert.equal(t.runs.length, 0);
    assert.equal(t.mgr.updating.has('h1'), false);
    assert.deepEqual(readRecord(t.dataDir).installs, [], 'no try was noted for a host that’s gone');
  } finally {
    t.done();
  }
});

test('#464-b2a: a record read that throws (EACCES) is caught: the link still stops, its status says why, nothing rejects', async () => {
  const t = rig();
  const unhandled = [];
  const on = (/** @type {unknown} */ e) => unhandled.push(e);
  process.on('unhandledRejection', on);
  const dir = join(t.dataDir, 'remote-installs');
  try {
    writeRecord(t.dataDir, { keepUpdated: true, installs: [] });
    chmodSync(dir, 0o000);
    const f = await t.mgr.connect('h1').catch((e) => e);
    assert.equal(f.kind, 'not-installed');
    await settle();
    assert.equal(t.mgr.link('h1').state, 'stopped', 'the reconnector reached stopped');
    assert.equal(t.runs.length, 0);
    assert.equal(typeof t.mgr.status('h1').update?.error, 'string', 'the status says the record couldn’t be read');
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', on);
    chmodSync(dir, 0o700);
    t.done();
  }
});

test('#464-b2a: maybeUpdate returns normally when its state is broken or hostOf throws', async () => {
  const { maybeUpdate } = await import('../server/remote/hosts-update.mjs');
  const throwing = {
    getHost: () => {
      throw new Error('the store is gone');
    },
    dataDir: '/nonexistent',
    version: VERSION,
    tokens: new Map(),
    links: new Map(),
    updating: new Map(),
    installRecords: new Map(),
  };
  assert.doesNotThrow(() => maybeUpdate(throwing, 'h1', f127()));
  assert.equal(throwing.updating.size, 0);
  assert.doesNotThrow(() => maybeUpdate(/** @type {any} */ ({}), 'h1', f127()));
  assert.doesNotThrow(() => maybeUpdate(throwing, 'h1', /** @type {any} */ (null)));
});
