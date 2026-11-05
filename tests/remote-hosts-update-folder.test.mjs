// The install records’ folder itself (server/remote/install-record.mjs, #464-b2a): O_NOFOLLOW covers only the record
// file, so a records folder that’s a link to elsewhere is refused on the read, and never chmodded on a write.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { sleep } from './remote-hosts-fixtures.mjs';
import { rig } from './remote-hosts-update-fixtures.mjs';

const valid = JSON.stringify({ keepUpdated: true, installs: [] });

test('#464-b2a: a records folder that’s a link to elsewhere is no consent, and a write never changes its target', {
  skip: process.platform === 'win32' && 'no symlinks',
}, async () => {
  const elsewhere = mkdtempSync(join(tmpdir(), 'pb-test-records-elsewhere-'));
  const t = rig();
  try {
    writeFileSync(join(elsewhere, 'h1'), valid, { mode: 0o600 });
    mkdirSync(t.dataDir, { recursive: true });
    symlinkSync(elsewhere, join(t.dataDir, 'remote-installs'));
    const before = statSync(elsewhere).mode & 0o777;
    await t.mgr.connect('h1').catch(() => {});
    await sleep(40);
    assert.equal(t.runs.length, 0, 'the record behind the link wasn’t read as consent');
    assert.equal(t.mgr.status('h1').keepUpdated, false);
    await assert.rejects(t.mgr.setKeepUpdated('h1', true), /isn’t a real folder/);
    assert.equal(statSync(elsewhere).mode & 0o777, before, 'the link’s target wasn’t chmodded');
  } finally {
    t.done();
    rmSync(elsewhere, { recursive: true, force: true });
  }
});
