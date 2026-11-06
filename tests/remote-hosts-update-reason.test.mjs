// #464-b2b: why an automatic install failed, on the host’s status, so its card can say so (hosts-update.mjs’s
// noteFailed): an installer’s SshFailure in the words Install… would show, kept in memory only; nothing from any other
// error, whose message may name a path on this computer. tests/remote-hosts-update-fixtures.mjs’s fake answers.

import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { sleep, until } from './remote-hosts-fixtures.mjs';
import { BUSY, fails, hangs, MISMATCH, rig } from './remote-hosts-update-fixtures.mjs';

const settle = () => sleep(40);

test('#464-b2b: a failed install’s own reason and next step reach the host’s status, and a later write clears them', async () => {
  const t = rig({ install: fails(66, MISMATCH) });
  try {
    await t.mgr.setKeepUpdated('h1', true);
    const e = await t.mgr.ensureWelcome('h1').then(
      () => null,
      (f) => f,
    );
    const shown = t.mgr.status('h1').update;
    assert.equal(shown.outcome, 'failed');
    assert.equal(shown.error, `${e.message} ${e.next}`, 'the card can say why, as the caller heard it');
    await t.mgr.setKeepUpdated('h1', false);
    assert.equal(t.mgr.status('h1').update.error, undefined, 'a later write of the record clears it');
  } finally {
    t.done();
  }
});

test('#464-b2b: a failed install that isn’t an SshFailure puts no message of its own on the status', async () => {
  const t = rig();
  const token = join(t.dataDir, 'remote-tokens', 'h1');
  try {
    await t.mgr.setKeepUpdated('h1', true);
    t.mgr.status('h1');
    rmSync(token);
    mkdirSync(token);
    await t.mgr.ensureWelcome('h1').catch(() => {});
    await settle();
    const shown = t.mgr.status('h1').update;
    assert.equal(shown?.outcome, 'failed', 'the token couldn’t be kept');
    assert.equal(shown.error, undefined, `a raw error’s message may name a path on this computer: ${shown.error}`);
  } finally {
    t.done();
  }
});

test('#464-b2b: a caller waiting on a busy install goes on once the host connects after it', async () => {
  /** @type {any} */
  let t = null;
  t = rig({
    install: (/** @type {any} */ c) => {
      t.attach = 'daemon';
      c.fail(75, BUSY);
    },
  });
  try {
    await t.mgr.setKeepUpdated('h1', true);
    const welcome = await t.mgr.ensureWelcome('h1');
    assert.ok(welcome, 'the other Postbox’s install of this version let it connect');
    assert.equal(t.mgr.status('h1').update.outcome, 'busy');
    assert.equal(t.runs.length, 1);
  } finally {
    t.done();
  }
});

test('#464-b2b: a caller that hears any failure while the person’s Install… runs waits for it, not only a 127', async () => {
  const t = rig({ attach: '126', install: hangs });
  try {
    t.mgr.install('h1').catch(() => {});
    await until(() => t.runs.length === 1, 'the install started');
    let settled = false;
    const call = t.mgr.ensureWelcome('h1').finally(() => {
      settled = true;
    });
    call.catch(() => {});
    await settle();
    assert.equal(settled, false, 'it waits for the install under way');
    t.mgr.close();
    await assert.rejects(call);
  } finally {
    t.done();
  }
});

test('#464-b2b: a caller waiting on an install the consent withdrew gets the 127 it heard, not the withdrawal', async () => {
  const t = rig();
  try {
    await t.mgr.setKeepUpdated('h1', true);
    t.mgr.link('h1').on('failure', () => {
      t.mgr.setKeepUpdated('h1', false).catch(() => {});
    });
    const e = await t.mgr.ensureWelcome('h1').then(
      () => null,
      (f) => f,
    );
    assert.equal(e?.detail?.code, 127, 'the host’s own failure, with Install…');
    assert.equal(t.runs.length, 0);
  } finally {
    t.done();
  }
});
