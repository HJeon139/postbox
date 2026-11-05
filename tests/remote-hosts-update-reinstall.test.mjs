// #464-b3 (designs/464-keep-updated.md, “What b3 adds”, D4): a host whose ~/.postbox-remote is gone, while this
// computer still has a token for it, exits 127 and is installed again with a new host token. The install compares
// the token it found here with the new one before keeping the new one, says tokenChanged, and the record says
// reinstalled; the token itself is never in the result’s status or the record. tests/remote-hosts-update-fixtures.mjs.

import assert from 'node:assert/strict';
import { chmodSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { updateShown } from '../app/js/keep-updated.mjs';
import { tokenFile } from '../server/remote/install.mjs';
import { FAKE_TOKEN } from './fake-daemon.mjs';
import { sleep, until, VERSION } from './remote-hosts-fixtures.mjs';
import { fails, installs, MISMATCH, readRecord, recordFile, rig, writeRecord } from './remote-hosts-update-fixtures.mjs';

const OLD = 'old-token-0123456789abcdefghijklmnopqrstu';
const settle = () => sleep(40);

test('#464-b3: an install that makes a new token says tokenChanged, and one that keeps the token says not', async () => {
  const changed = rig({ token: OLD });
  const same = rig();
  try {
    assert.equal((await changed.mgr.install('h1')).tokenChanged, true);
    assert.equal((await same.mgr.install('h1')).tokenChanged, false);
  } finally {
    changed.done();
    same.done();
  }
});

test('#464-b3: an automatic install that made a new token is recorded reinstalled; one that kept it, installed', async () => {
  const changed = rig({ token: OLD });
  const same = rig();
  try {
    for (const t of [changed, same]) {
      await t.mgr.setKeepUpdated('h1', true);
      await t.mgr.connect('h1').catch(() => {});
    }
    await until(() => readRecord(changed.dataDir)?.installs?.[0]?.outcome === 'reinstalled', 'reinstalled');
    await until(() => readRecord(same.dataDir)?.installs?.[0]?.outcome === 'installed', 'installed');
    assert.equal(changed.mgr.status('h1').update.outcome, 'reinstalled');
  } finally {
    changed.done();
    same.done();
  }
});

test('#464-b3: neither token reaches the record or the host’s status', async () => {
  const t = rig({ token: OLD });
  try {
    await t.mgr.setKeepUpdated('h1', true);
    await t.mgr.connect('h1').catch(() => {});
    await until(() => readRecord(t.dataDir)?.installs?.[0]?.outcome === 'reinstalled', 'reinstalled');
    await settle();
    const seen = `${readFileSync(recordFile(t.dataDir), 'utf8')}\n${JSON.stringify(t.mgr.status('h1'))}`;
    assert.ok(!seen.includes(OLD), 'not the old token');
    assert.ok(!seen.includes(FAKE_TOKEN), 'not the new one');
  } finally {
    t.done();
  }
});

test('#464-b3: once reinstalled, a folder gone again under the same version installs nothing by itself', async () => {
  const t = rig({ token: OLD });
  try {
    await t.mgr.setKeepUpdated('h1', true);
    await t.mgr.connect('h1').catch(() => {});
    await until(() => readRecord(t.dataDir)?.installs?.[0]?.outcome === 'reinstalled', 'reinstalled');
    await settle();
    await t.mgr.connect('h1').catch(() => {});
    await settle();
    assert.equal(t.runs.length, 1, 'this version is tried');
  } finally {
    t.done();
  }
});

test('#464-b3: Install… still repairs a host whose token file here can’t be read, and says no token changed', async () => {
  const t = rig({ token: OLD });
  try {
    chmodSync(tokenFile(t.dataDir, 'h1'), 0o000);
    const r = await t.mgr.install('h1');
    assert.equal(r.installed, true);
    assert.equal(r.tokenChanged, false, 'an unreadable token is no token to compare');
  } finally {
    t.done();
  }
});

test('#464-b3: a new token where this version was already there is present, not reinstalled', async () => {
  const t = rig({
    token: OLD,
    install: (/** @type {any} */ c) => {
      c.stdout.write(`present ${VERSION}\n`);
      c.exit(0);
    },
  });
  try {
    await t.mgr.setKeepUpdated('h1', true);
    await t.mgr.connect('h1').catch(() => {});
    await until(() => ['present', 'reinstalled'].includes(readRecord(t.dataDir)?.installs?.[0]?.outcome), 'it ended');
    assert.equal(readRecord(t.dataDir).installs[0].outcome, 'present', 'the turns there weren’t shown gone');
  } finally {
    t.done();
  }
});

test('#464-b3: a record that says reinstalled reads back as reinstalled', () => {
  const t = rig();
  try {
    writeRecord(t.dataDir, { keepUpdated: true, installs: [{ version: VERSION, at: 1, outcome: 'reinstalled' }] });
    assert.equal(t.mgr.status('h1').update.outcome, 'reinstalled');
  } finally {
    t.done();
  }
});

test('#464-b3: the person’s Install… that puts Postbox back after a failed automatic try is present, and the card says nothing', async () => {
  const t = rig({ token: OLD, install: fails(66, MISMATCH) });
  try {
    await t.mgr.setKeepUpdated('h1', true);
    await t.mgr.connect('h1').catch(() => {});
    await until(() => readRecord(t.dataDir)?.installs?.[0]?.outcome === 'failed', 'the automatic install failed');
    await until(() => !t.mgr.updating.has('h1'), 'and ended');
    t.install = installs;
    t.attach = 'daemon';
    assert.equal((await t.mgr.install('h1')).tokenChanged, true, 'it made a new token');
    // Not reinstalled: the card would say Postbox installed it again by itself, and host-reinstalled would count it.
    assert.equal(readRecord(t.dataDir).installs[0].outcome, 'present');
    await until(() => t.mgr.status('h1').state === 'connected', 'the host connects');
    assert.equal(updateShown(t.mgr.status('h1')), null, 'the card says nothing of an install Postbox didn’t do');
  } finally {
    t.done();
  }
});
