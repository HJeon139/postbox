// The consent’s and Remove’s bounds on an automatic install (#464-b2a; the integrator’s review at dc600a59): a 127
// heard while the person turns the consent off installs nothing, Remove waits for an install under way and then
// removes what it installed, and an install that a crash or close() cut off says so on the host’s status, with
// Install…, rather than looking under way. tests/remote-hosts-update-fixtures.mjs’s fake answers.

import assert from 'node:assert/strict';
import test from 'node:test';
import { sleep, until } from './remote-hosts-fixtures.mjs';
import { installs, readRecord, rig, writeRecord } from './remote-hosts-update-fixtures.mjs';

const settle = () => sleep(40);

test('#464-b2a: a 127 heard while the consent is being turned off installs nothing', async () => {
  const t = rig();
  try {
    await t.mgr.setKeepUpdated('h1', true);
    // In the failure’s own tick, after the rule decided: the person’s off reaches the record before the install’s note.
    t.mgr.link('h1').on('failure', () => {
      t.mgr.setKeepUpdated('h1', false).catch(() => {});
    });
    await t.mgr.connect('h1').catch(() => {});
    await settle();
    assert.equal(t.runs.length, 0, 'no install ran');
    const record = readRecord(t.dataDir);
    assert.equal(record.keepUpdated, false);
    assert.deepEqual(record.installs, [], 'and none was noted');
  } finally {
    t.done();
  }
});

test('#464-b2a: Remove during an automatic install waits for it, then removes Postbox through the new version', async () => {
  /** @type {any} */
  let t = null;
  /** @type {() => void} */
  let release = () => {};
  t = rig({
    install: (/** @type {any} */ c) => {
      release = () => {
        t.attach = 'daemon';
        installs(c);
      };
    },
  });
  try {
    await t.mgr.setKeepUpdated('h1', true);
    await t.mgr.connect('h1').catch(() => {});
    await until(() => t.runs.length === 1, 'the install started');
    const removing = t.mgr.removeFromHost('h1');
    await settle();
    assert.equal(t.daemon.received.filter((m) => m.type === 'remove').length, 0, 'nothing removed while it installs');
    assert.equal(t.mgr.status('h1').update.error, undefined, 'an install under way isn’t one cut off');
    release();
    await removing;
    assert.equal(t.daemon.received.filter((m) => m.type === 'remove').length, 1, 'then removed, version and token with it');
  } finally {
    t.done();
  }
});

test('#464-b2a: an install a crash or close() cut off says so on the host’s status, with what to do', async () => {
  const t = rig();
  try {
    writeRecord(t.dataDir, { keepUpdated: true, installs: [{ version: '0.10.0', at: 1, outcome: 'started' }] });
    const update = t.mgr.status('h1').update;
    assert.equal(update.outcome, 'started');
    assert.match(update.error ?? '', /stopped during its install of 0\.10\.0 here.*Install it from here/);
  } finally {
    t.done();
  }
});
