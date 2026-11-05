// What the host’s status says of its automatic install once something else has fixed the host (#464-b2b; the
// integrator’s review of #770 at 5603dd08): the person’s own Install… supersedes a failed try in the record, and a
// try of a version other than this Postbox’s says nothing. tests/remote-hosts-update-fixtures.mjs’s fake answers.

import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { updateShown } from '../app/js/keep-updated.mjs';
import { sleep, until, VERSION } from './remote-hosts-fixtures.mjs';
import { fails, installs, MISMATCH, readRecord, recordFile, rig, writeRecord } from './remote-hosts-update-fixtures.mjs';

const settle = () => sleep(40);

test('#464-b2b: after a failed automatic install, the person’s Install… that works makes the card say nothing', async () => {
  const t = rig({ install: fails(66, MISMATCH) });
  try {
    await t.mgr.setKeepUpdated('h1', true);
    await t.mgr.connect('h1').catch(() => {});
    await until(() => readRecord(t.dataDir)?.installs?.[0]?.outcome === 'failed', 'the automatic install failed');
    await until(() => !t.mgr.updating.has('h1'), 'and ended');
    t.install = installs;
    t.attach = 'daemon';
    await t.mgr.install('h1');
    await until(() => t.mgr.status('h1').state === 'connected', 'the host connects after the install');
    let st = t.mgr.status('h1');
    // Not “installed”: the card would say Postbox installed it by itself, and host-auto-installed would count it.
    assert.equal(st.update.outcome, 'present', 'the try is rewritten as present, which the card says nothing for');
    assert.equal(updateShown(st), null, 'connected, the card says nothing of an install Postbox didn’t do');
    t.mgr.link('h1').idle();
    await settle();
    st = t.mgr.status('h1');
    assert.equal(st.state, 'disconnected', 'idle, as two minutes later');
    assert.equal(st.update.error, undefined, 'and keeps no installer error');
    assert.equal(updateShown(st), null, 'idle, still nothing');
    assert.equal(readRecord(t.dataDir).installs.length, 1, 'the same try, rewritten, so this version stays tried');
  } finally {
    t.done();
  }
});

test('#464-b2b: the person’s Install… on a host removed while it ran leaves the record as it was', async () => {
  const t = rig();
  try {
    const tried = [{ version: VERSION, at: 1, outcome: 'failed' }];
    writeRecord(t.dataDir, { keepUpdated: true, installs: tried });
    t.install = (/** @type {any} */ c) => {
      delete t.hosts.h1;
      installs(c);
    };
    await t.mgr.install('h1').catch(() => {});
    await settle();
    assert.deepEqual(readRecord(t.dataDir)?.installs, tried, 'nothing is written for a host that’s gone');
  } finally {
    t.done();
  }
});

test('#464-b2b: a note that the record couldn’t be written stays on the status beside another version’s try', async () => {
  const t = rig();
  try {
    writeRecord(t.dataDir, { keepUpdated: true, installs: [{ version: '0.9.0', at: 1, outcome: 'installed' }] });
    t.mgr.status('h1');
    // The record is kept now; a folder where its file was makes the next write’s rename fail.
    rmSync(recordFile(t.dataDir));
    mkdirSync(join(recordFile(t.dataDir), 'x'), { recursive: true });
    await t.mgr.connect('h1').catch(() => {});
    await until(() => t.mgr.status('h1').update?.error, 'the note of the try couldn’t be written');
    const st = t.mgr.status('h1');
    assert.match(st.update.error, /couldn’t note the install in its data folder/);
    assert.equal(st.update.version, null, 'with no line for 0.9.0’s try');
    assert.equal(updateShown(st), 'failed', 'so the card says what went wrong, with Install…');
  } finally {
    t.done();
  }
});

test('#464-b2b: a try of another version says nothing on the host’s status, whatever its outcome', () => {
  for (const outcome of ['failed', 'installed', 'reinstalled', 'started']) {
    const t = rig();
    try {
      writeRecord(t.dataDir, { keepUpdated: true, installs: [{ version: '0.9.0', at: 1, outcome }] });
      assert.equal(t.mgr.status('h1').update, null, `${outcome} for 0.9.0, with this Postbox at ${VERSION}`);
    } finally {
      t.done();
    }
  }
});

test('#464-b2b: the person’s Install… leaves another version’s try in the record as it was', async () => {
  const t = rig();
  try {
    writeRecord(t.dataDir, { keepUpdated: true, installs: [{ version: '0.9.0', at: 1, outcome: 'failed' }] });
    t.attach = 'daemon';
    await t.mgr.install('h1');
    await settle();
    assert.deepEqual(readRecord(t.dataDir).installs, [{ version: '0.9.0', at: 1, outcome: 'failed' }]);
  } finally {
    t.done();
  }
});

test('#464-b2b: the person’s Install… leaves this version’s try as it was once it installed, reinstalled or found it there', async () => {
  for (const outcome of ['installed', 'reinstalled', 'present']) {
    const t = rig();
    try {
      const tried = [{ version: VERSION, at: 1, outcome }];
      writeRecord(t.dataDir, { keepUpdated: true, installs: tried });
      t.attach = 'daemon';
      await t.mgr.install('h1');
      await settle();
      assert.deepEqual(readRecord(t.dataDir).installs, tried, `a ${outcome} try stays ${outcome}`);
    } finally {
      t.done();
    }
  }
});
