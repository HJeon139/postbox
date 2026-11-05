// #464-b3 (designs/464-keep-updated.md, “What b3 adds”, D4): a host whose ~/.postbox-remote is gone, while this
// computer still has a token for it, exits 127 and is installed again with a new host token. The install compares
// the token it found here with the new one before keeping the new one, says tokenChanged, and the record says
// reinstalled; the token itself is never in the result’s status or the record. tests/remote-hosts-update-fixtures.mjs.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { FAKE_TOKEN } from './fake-daemon.mjs';
import { sleep, until } from './remote-hosts-fixtures.mjs';
import { readRecord, recordFile, rig } from './remote-hosts-update-fixtures.mjs';

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
