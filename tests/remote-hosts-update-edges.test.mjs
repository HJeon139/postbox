// The automatic install’s edges (server/remote/hosts-update.mjs, #464-b2a), from its pre-review packet: Remove
// doesn’t install on the host it’s removing, close() stops the person’s own Install… too, and a status whose
// automatic install alone changed is still emitted. ssh is never run: tests/remote-hosts-update-fixtures.mjs answers.

import assert from 'node:assert/strict';
import test from 'node:test';
import { sleep, until } from './remote-hosts-fixtures.mjs';
import { hangs, readRecord, rig } from './remote-hosts-update-fixtures.mjs';

const settle = () => sleep(40);

test('#464-b2a: removing a host whose version is missing doesn’t install on it first, consent or not', async () => {
  const t = rig();
  try {
    await t.mgr.setKeepUpdated('h1', true);
    await t.mgr.removeFromHost('h1').catch(() => {});
    await settle();
    assert.equal(t.runs.length, 0, 'Remove’s connect hit the 127, and nothing installed');
    assert.equal(readRecord(t.dataDir).installs.length, 0);
  } finally {
    t.done();
  }
});

test('#464-b2a: close() stops the person’s own Install… under way, as it does an automatic one', async () => {
  const t = rig({ install: hangs });
  try {
    const pressed = t.mgr.install('h1').then(
      () => null,
      (e) => e,
    );
    await until(() => t.runs.length === 1, 'the install started');
    t.mgr.close();
    const e = await pressed;
    assert.deepEqual(t.runs[0].kills, ['SIGKILL']);
    assert.match(String(e?.message), /Postbox closed before the install finished/);
  } finally {
    t.done();
  }
});

test('#464-b2a: a change to the automatic install alone is emitted as a status change', async () => {
  const t = rig();
  try {
    await t.mgr.setKeepUpdated('h1', true);
    const seen = [];
    t.mgr.on('status', (_id, s) => seen.push(s));
    await t.mgr.setKeepUpdated('h1', false);
    assert.ok(
      seen.some((s) => s.keepUpdated === false),
      'turning the consent off, with nothing else changed, emits a status that says so',
    );
  } finally {
    t.done();
  }
});
