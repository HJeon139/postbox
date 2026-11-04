// #464-b2b: why an automatic install failed, on the host’s status, so its card can say so (hosts-update.mjs’s
// noteFailed): an installer’s SshFailure in the words Install… would show, kept in memory only; nothing from any other
// error, whose message may name a path on this computer. tests/remote-hosts-update-fixtures.mjs’s fake answers.

import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { sleep } from './remote-hosts-fixtures.mjs';
import { fails, MISMATCH, rig } from './remote-hosts-update-fixtures.mjs';

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
