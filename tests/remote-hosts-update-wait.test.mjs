// The waiting caller (server/remote/hosts-links.mjs’s ensureWelcome, #464-b2b; designs/464-keep-updated.md, “What b2b
// adds”): a caller that hears the 127 while an automatic install runs waits for it, then tries once more from the top,
// and gets the new welcome, or the installer’s failure; removing Postbox from the host doesn’t wait. ssh is never run:
// tests/remote-hosts-update-fixtures.mjs’s fake answers.

import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import { sleep, until } from './remote-hosts-fixtures.mjs';
import { fails, hangs, installs, MISMATCH, readRecord, rig } from './remote-hosts-update-fixtures.mjs';

/** Lets the install, its record writes and the reconnect after it run. */
const settle = () => sleep(40);

/** A promise’s outcome as it settles, for a test that checks it hasn’t yet. @param {Promise<any>} p */
function watch(p) {
  /** @type {{ settled: boolean, value?: any, error?: any }} */
  const w = { settled: false };
  p.then(
    (value) => Object.assign(w, { settled: true, value }),
    (error) => Object.assign(w, { settled: true, error }),
  );
  return w;
}

/**
 * Holds the nth write of an install record (its rename into place) until release(); the consent’s own write is the
 * first. restore() puts the real rename back.
 * @param {number} nth
 */
function holdRecordWrite(nth) {
  const real = fsp.rename;
  let n = 0;
  /** @type {() => void} */
  let release = () => {};
  const held = new Promise((r) => (release = () => r(undefined)));
  const hold = { reached: false, release, restore: () => {} };
  fsp.rename = async (from, to) => {
    if (String(to).includes('remote-installs') && ++n === nth) {
      hold.reached = true;
      await held;
    }
    return real(from, to);
  };
  syncBuiltinESMExports();
  hold.restore = () => {
    fsp.rename = real;
    syncBuiltinESMExports();
  };
  return hold;
}

/** The rig, whose install makes the host’s attach reach the daemon from then on, as an installed version does. @param {object} [o] */
function installedRig(o = {}) {
  /** @type {any} */
  const t = rig({
    install: (/** @type {any} */ child) => {
      t.attach = 'daemon';
      installs(child);
    },
    ...o,
  });
  return t;
}

test('#464-b2b: a caller that hears the 127 with the consent on waits for the install, then resolves with the new welcome', async () => {
  const t = installedRig();
  try {
    await t.mgr.setKeepUpdated('h1', true);
    const w = await t.mgr.ensureWelcome('h1');
    assert.equal(w.type, 'welcome', 'the new version’s welcome, and no failure');
    assert.equal(t.runs.length, 1, 'one install');
    assert.equal(readRecord(t.dataDir).installs[0].outcome, 'installed');
    assert.equal(t.mgr.link('h1').connected, true);
  } finally {
    t.done();
  }
});

test('#464-b2b: a caller that finds the link stopped while an install runs waits for it, then connects', async () => {
  const t = rig({ install: hangs });
  try {
    await t.mgr.setKeepUpdated('h1', true);
    await t.mgr.connect('h1').catch(() => {});
    await until(() => t.runs.length === 1, 'the install started, and hangs');
    assert.equal(t.mgr.link('h1').state, 'stopped');
    const w = watch(t.mgr.ensureWelcome('h1'));
    await settle();
    assert.equal(w.settled, false, 'it waits for the install rather than throwing the 127');
    t.attach = 'daemon';
    t.runs[0].answer();
    await until(() => w.settled, 'the caller settled');
    assert.equal(w.error, undefined);
    assert.equal(w.value.type, 'welcome');
  } finally {
    t.done();
  }
});

test('#464-b2b: a slowed first record write delays the install, and the caller waits for it all the same', async () => {
  const t = installedRig();
  const hold = holdRecordWrite(2);
  try {
    await t.mgr.setKeepUpdated('h1', true);
    const w = watch(t.mgr.ensureWelcome('h1'));
    await until(() => hold.reached, 'the started write is held');
    await settle();
    assert.equal(t.runs.length, 0, 'no ssh before the record says started');
    assert.equal(w.settled, false, 'the caller is waiting');
    hold.release();
    await until(() => w.settled, 'the caller settled');
    assert.equal(w.error, undefined);
    assert.equal(w.value.type, 'welcome');
  } finally {
    hold.restore();
    t.done();
  }
});

test('#464-b2b: a welcome that arrives before the install’s last record write is the one the caller gets', async () => {
  const t = installedRig();
  const hold = holdRecordWrite(3);
  try {
    await t.mgr.setKeepUpdated('h1', true);
    const w = watch(t.mgr.ensureWelcome('h1'));
    await until(() => hold.reached && t.mgr.link('h1').connected, 'connected, with the installed write held');
    const welcome = t.mgr.link('h1').welcome;
    await settle();
    assert.equal(w.settled, false, 'the caller waits for the install’s end');
    hold.release();
    await until(() => w.settled, 'the caller settled');
    assert.equal(w.error, undefined);
    assert.equal(w.value, welcome, 'the welcome that came meanwhile');
  } finally {
    hold.restore();
    t.done();
  }
});

test('#464-b2b: after an install that replaced the link, the caller gets the new link’s welcome', async () => {
  const t = installedRig({ token: 'old-token-0123456789abcdefghijklmnopqrstu' });
  try {
    await t.mgr.setKeepUpdated('h1', true);
    const old = t.mgr.link('h1');
    const w = watch(t.mgr.ensureWelcome('h1'));
    await until(() => w.settled, 'the caller settled');
    assert.equal(w.error, undefined);
    assert.equal(old.state, 'closed', 'the old token’s link was dropped');
    const now = t.mgr.link('h1');
    assert.notEqual(now, old);
    assert.equal(w.value, now.welcome);
  } finally {
    t.done();
  }
});

test('#464-b2b: when the install’s own connect is spent before the caller looks again, the caller’s retry connects', async () => {
  const t = rig();
  // The install’s last write waits until its own connect has failed and stopped the link again.
  const hold = holdRecordWrite(3);
  try {
    await t.mgr.setKeepUpdated('h1', true);
    const l = t.mgr.link('h1');
    let failures = 0;
    l.on('failure', () => {
      failures++;
      // The install’s connect 127s, as before the version was there; the next attempt finds it.
      if (failures === 2) t.attach = 'daemon';
    });
    const w = watch(t.mgr.ensureWelcome('h1'));
    await until(() => failures === 2 && l.state === 'stopped' && hold.reached, 'the install’s connect failed');
    hold.release();
    await until(() => w.settled, 'the caller settled');
    assert.equal(w.error, undefined, 'the caller retried the stopped link itself');
    assert.equal(w.value.type, 'welcome');
    assert.equal(t.runs.length, 1);
  } finally {
    hold.restore();
    t.done();
  }
});

test('#464-b2b: a failed install gives the caller the installer’s failure, not the 127', async () => {
  const t = rig({ install: fails(66, MISMATCH) });
  try {
    await t.mgr.setKeepUpdated('h1', true);
    const e = await t.mgr.ensureWelcome('h1').then(
      () => null,
      (f) => f,
    );
    assert.notEqual(e, null, 'it rejects');
    assert.notEqual(e.kind, 'not-installed');
    assert.equal(e.detail?.code, 66, 'the installer’s exit');
    assert.equal(typeof e.next, 'string', 'with its next step');
    assert.equal(t.runs.length, 1);
  } finally {
    t.done();
  }
});

test('#464-b2b: an install that succeeds while the host still 127s fails the caller once, with no loop and no second install', async () => {
  const t = rig();
  try {
    await t.mgr.setKeepUpdated('h1', true);
    const e = await t.mgr.ensureWelcome('h1').then(
      () => null,
      (f) => f,
    );
    assert.equal(e?.detail?.code, 127);
    await settle();
    assert.equal(t.runs.length, 1, 'the version is tried, so nothing installs again');
    assert.ok(t.dials.length <= 3, `the 127, the install’s connect and at most one retry: ${t.dials.length}`);
  } finally {
    t.done();
  }
});

test('#464-b2b: a caller waits for one install at most, though another is under way when it tries again', async () => {
  const t = rig();
  const hold = holdRecordWrite(3);
  try {
    await t.mgr.setKeepUpdated('h1', true);
    const l = t.mgr.link('h1');
    let failures = 0;
    /** @type {Promise<any> | null} */
    let pressed = null;
    l.on('failure', () => {
      failures++;
      // The caller’s own retry 127s too, and the person presses Install… in that tick: an install is under way again.
      if (failures !== 3) return;
      t.install = hangs;
      pressed = t.mgr.install('h1').catch((/** @type {any} */ f) => f);
    });
    const w = watch(t.mgr.ensureWelcome('h1'));
    await until(() => failures === 2 && l.state === 'stopped' && hold.reached, 'the install’s connect failed');
    hold.release();
    await until(() => w.settled, 'the caller settled without waiting for the second install');
    assert.equal(w.error?.detail?.code, 127);
    assert.equal(t.mgr.updating.has('h1'), true, 'the person’s install is still under way');
    await until(() => typeof t.runs[1]?.answer === 'function', 'the person’s install started');
    t.runs[1].answer();
    await pressed;
  } finally {
    hold.restore();
    t.done();
  }
});

test('#464-b2b: removing Postbox from a host while an install is held open doesn’t wait, and gets the stopped link’s failure', async () => {
  const t = rig({ install: hangs });
  try {
    await t.mgr.setKeepUpdated('h1', true);
    await t.mgr.connect('h1').catch(() => {});
    await until(() => t.runs.length === 1, 'the install started, and hangs');
    const w = watch(t.mgr.removeFromHost('h1'));
    await until(() => w.settled, 'the removal settled while the install is held');
    assert.equal(w.error?.detail?.code, 127, 'the stopped link’s failure');
    assert.match(String(w.error?.next), /remove it again/);
    assert.equal(t.runs[0].exited, false, 'the install is still held open');
    t.runs[0].answer();
  } finally {
    t.done();
  }
});

test('#464-b2b: with the consent off, a caller that hears the 127 throws it at once, as before', async () => {
  const t = rig();
  try {
    const e = await t.mgr.ensureWelcome('h1').then(
      () => null,
      (f) => f,
    );
    assert.equal(e?.kind, 'not-installed');
    assert.equal(e?.detail?.code, 127);
    assert.equal(t.mgr.updating.has('h1'), false);
    await settle();
    assert.equal(t.runs.length, 0);
    assert.equal(t.dials.length, 1, 'one attempt, and no retry');
  } finally {
    t.done();
  }
});
