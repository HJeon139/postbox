// An automatic install’s life (server/remote/hosts-update.mjs and hosts.mjs’s install(), #464-b2a; designs/464-keep-updated.md,
// “One install at a time, and exit 75”): one install at a time per host, shared with the person’s Install…; exit 75; a
// failure nobody waits for; close() and forget() while one runs.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';
import { tokenFile } from '../server/remote/install.mjs';
import { sleep, until, VERSION } from './remote-hosts-fixtures.mjs';
import { BUSY, fails, hangs, MISMATCH, readRecord, recordFile, rig } from './remote-hosts-update-fixtures.mjs';

const settle = () => sleep(40);

test('#464-b2a: two 127s in quick succession, and the person’s Install… during the automatic one, give one ssh install', async () => {
  const t = rig({ install: hangs });
  try {
    await t.mgr.setKeepUpdated('h1', true);
    const l = t.mgr.link('h1');
    // A second 127 in the same tick as the first, before the record’s first write can have finished.
    let again = true;
    l.on('failure', (/** @type {any} */ f) => {
      if (!again) return;
      again = false;
      l.emit('failure', f);
    });
    await t.mgr.connect('h1').catch(() => {});
    await until(() => t.runs.length === 1, 'the automatic install started');
    // A later attempt that exits 127 too, while the install runs.
    await t.mgr.connect('h1').catch(() => {});
    const pressed = t.mgr.install('h1');
    await settle();
    assert.equal(t.runs.length, 1, 'still one');
    t.runs[0].answer();
    const r = await pressed;
    assert.equal(r.version, VERSION, 'the button gets the automatic install’s outcome');
    await settle();
    assert.equal(t.runs.length, 1);
  } finally {
    t.done();
  }
});

test('#464-b2a: an install that exits 75 records busy and connects once more', async () => {
  const t = rig({ install: fails(75, BUSY) });
  try {
    await t.mgr.setKeepUpdated('h1', true);
    await t.mgr.connect('h1').catch(() => {});
    await until(() => readRecord(t.dataDir)?.installs?.[0]?.outcome === 'busy', 'busy');
    // A slow machine dials the connect after busy later than a fixed wait (CI on 3d831e58): wait for it, then settle.
    await until(() => t.dials.length >= 2, 'the connect after busy');
    await settle();
    assert.equal(t.dials.length, 2, 'the 127, then one connectNow after busy');
    assert.equal(t.runs.length, 1, 'the second 127 finds this version tried');
  } finally {
    t.done();
  }
});

test('#464-b2a: a failed automatic install with nobody waiting records failed and rejects nothing unhandled', async () => {
  const t = rig({ install: fails(66, MISMATCH) });
  const unhandled = [];
  const on = (/** @type {unknown} */ e) => unhandled.push(e);
  process.on('unhandledRejection', on);
  try {
    await t.mgr.setKeepUpdated('h1', true);
    await t.mgr.connect('h1').catch(() => {});
    await until(() => readRecord(t.dataDir)?.installs?.[0]?.outcome === 'failed', 'failed');
    await settle();
    assert.deepEqual(unhandled, []);
    assert.equal(t.mgr.updating.has('h1'), false);
    assert.equal(t.mgr.status('h1').update.outcome, 'failed');
  } finally {
    process.off('unhandledRejection', on);
    t.done();
  }
});

test('#464-b2a: close() during an automatic install kills its ssh child, and the record stays started', async () => {
  const t = rig({ install: hangs });
  try {
    await t.mgr.setKeepUpdated('h1', true);
    await t.mgr.connect('h1').catch(() => {});
    await until(() => t.runs.length === 1, 'the install started');
    t.mgr.close();
    await until(() => t.runs[0].exited, 'the child ended');
    assert.deepEqual(t.runs[0].kills, ['SIGKILL']);
    await settle();
    assert.equal(readRecord(t.dataDir).installs[0].outcome, 'started');
  } finally {
    t.done();
  }
});

test('#464-b2a: forget() during an automatic install waits for it, and leaves no token or record file behind', async () => {
  const t = rig({ install: hangs });
  try {
    await t.mgr.setKeepUpdated('h1', true);
    await t.mgr.connect('h1').catch(() => {});
    await until(() => t.runs.length === 1, 'the install started');
    let forgotten = false;
    const p = t.mgr.forget('h1').then((v) => {
      forgotten = true;
      return v;
    });
    await settle();
    assert.equal(forgotten, false, 'forget waits for the install');
    t.runs[0].answer();
    await p;
    await settle();
    assert.equal(existsSync(tokenFile(t.dataDir, 'h1')), false, 'no token file');
    assert.equal(existsSync(recordFile(t.dataDir)), false, 'no record file');
    assert.equal(t.mgr.updating.has('h1'), false);
  } finally {
    t.done();
  }
});

test('#464-b2a: turning the consent on for a host already stopped on a 127 connects once, and that installs', async () => {
  const t = rig();
  try {
    const f = await t.mgr.connect('h1').catch((e) => e);
    assert.equal(f.detail.code, 127);
    await settle();
    assert.equal(t.runs.length, 0, 'no consent yet, so no install');
    await t.mgr.setKeepUpdated('h1', true);
    await until(() => readRecord(t.dataDir)?.installs?.[0]?.outcome === 'installed', 'the record says installed');
    assert.equal(t.runs.length, 1);
  } finally {
    t.done();
  }
});
