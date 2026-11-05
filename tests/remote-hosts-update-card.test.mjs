// What the host’s status says of its automatic install once something else has fixed the host (#464-b2b; the
// integrator’s review of #770 at 5603dd08): the person’s own Install… supersedes a failed try in the record, and a
// try of a version other than this Postbox’s says nothing. tests/remote-hosts-update-fixtures.mjs’s fake answers.

import assert from 'node:assert/strict';
import test from 'node:test';
import { updateShown } from '../app/js/keep-updated.mjs';
import { sleep, until, VERSION } from './remote-hosts-fixtures.mjs';
import { fails, installs, MISMATCH, readRecord, rig, writeRecord } from './remote-hosts-update-fixtures.mjs';

const settle = () => sleep(40);

test('#464-b2b: after a failed automatic install, the person’s Install… that works stops the card saying it failed', async () => {
  const t = rig({ install: fails(66, MISMATCH) });
  try {
    await t.mgr.setKeepUpdated('h1', true);
    await t.mgr.connect('h1').catch(() => {});
    await until(() => readRecord(t.dataDir)?.installs?.[0]?.outcome === 'failed', 'the automatic install failed');
    await until(() => !t.mgr.updating.has('h1'), 'and ended');
    t.install = installs;
    t.attach = 'daemon';
    await t.mgr.install('h1');
    await settle();
    t.mgr.link('h1').idle();
    await settle();
    const st = t.mgr.status('h1');
    assert.equal(st.state, 'disconnected', 'idle, as two minutes later');
    assert.equal(st.update.outcome, 'installed', 'the record says this version is installed');
    assert.equal(st.update.error, undefined, 'and keeps no installer error');
    assert.notEqual(updateShown(st), 'failed');
    assert.equal(readRecord(t.dataDir).installs.length, 1, 'the same try, rewritten, so this version stays tried');
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
