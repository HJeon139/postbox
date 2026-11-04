// The automatic install’s edges (server/remote/hosts-update.mjs, #464-b2a), from its pre-review packet: Remove
// doesn’t install on the host it’s removing, close() stops the person’s own Install… too, a status whose consent or
// automatic install alone changed is still emitted, a version already there is noted present, turning the consent off
// connects nothing, and an install with a new token replaces the link made with the old one. ssh is never run:
// tests/remote-hosts-update-fixtures.mjs answers.

import assert from 'node:assert/strict';
import test from 'node:test';
import { FAKE_TOKEN } from './fake-daemon.mjs';
import { sleep, until, VERSION } from './remote-hosts-fixtures.mjs';
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

test('#464-b2a: a change to the consent (keepUpdated) alone is emitted as a status change', async () => {
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

test('#464-b2a: a change to the automatic install’s note (update) alone is emitted as a status change', async () => {
  const t = rig({ install: hangs });
  try {
    await t.mgr.setKeepUpdated('h1', true);
    /** @type {any[]} */
    const seen = [];
    t.mgr.on('status', (_id, s) => seen.push(s));
    await t.mgr.connect('h1').catch(() => {});
    await until(() => t.runs.length === 1, 'the install started, and hangs');
    const last = seen.at(-1);
    assert.equal(last?.update?.outcome, 'started', 'the started note, with the state and consent as they were, was emitted');
    assert.equal(seen.at(-2)?.state, last.state);
  } finally {
    t.done();
  }
});

test('#464-b2a: an automatic install that finds this version already there notes present, not installed', async () => {
  const t = rig({
    install: (/** @type {any} */ child) => {
      child.stdout.write(`present ${VERSION}\n`);
      child.exit(0);
    },
  });
  try {
    await t.mgr.setKeepUpdated('h1', true);
    await t.mgr.connect('h1').catch(() => {});
    await until(() => readRecord(t.dataDir)?.installs?.[0]?.outcome !== 'started' && t.runs.length === 1, 'the install ended');
    await settle();
    assert.equal(readRecord(t.dataDir).installs[0].outcome, 'present');
  } finally {
    t.done();
  }
});

test('#464-b2a: turning the consent off for a host stopped on a 127 doesn’t connect it again', async () => {
  const t = rig();
  try {
    const f = await t.mgr.connect('h1').catch((e) => e);
    assert.equal(f.detail.code, 127);
    await settle();
    assert.equal(t.mgr.link('h1').state, 'stopped');
    const dials = t.dials.length;
    await t.mgr.setKeepUpdated('h1', false);
    await settle();
    assert.equal(t.dials.length, dials, 'no ssh connect for the consent turned off');
  } finally {
    t.done();
  }
});

test('#464-b2a: an install whose token differs from the link’s replaces the link made with the old token', async () => {
  const t = rig({ token: 'old-token-0123456789abcdefghijklmnopqrstu' });
  try {
    await t.mgr.connect('h1').catch(() => {});
    const old = t.mgr.link('h1');
    const r = await t.mgr.install('h1');
    assert.equal(r.token, FAKE_TOKEN);
    assert.equal(old.state, 'closed', 'the old token’s link is closed');
    assert.notEqual(t.mgr.link('h1'), old, 'and a new one made with the new token');
  } finally {
    t.done();
  }
});
