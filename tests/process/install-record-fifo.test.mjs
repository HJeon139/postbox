// The install record’s strict read (server/remote/install-record.mjs, #464-b2a) refuses a FIFO where the record should
// be, without waiting for a writer: the read is synchronous, in the failure’s own tick, so an open that waited would
// stop all of Postbox. Making the FIFO takes `mkfifo`, and a read that hangs can only be stopped from outside, so the
// read runs in a child Node with a timeout, and this is under tests/process/ (the unit tests can’t start processes,
// tests/guard.mjs).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const RECORD = new URL('../../server/remote/install-record.mjs', import.meta.url).href;

/** The child: reads h1’s record from the data folder in argv, and prints what Postbox keeps of it. */
const READ = `
const { recordOf } = await import(${JSON.stringify(RECORD)});
const m = { dataDir: process.argv[1], installRecords: new Map(), recordWrites: new Map() };
console.log(JSON.stringify(recordOf(m, 'h1')));
`;

const hasMkfifo = process.platform !== 'win32' && spawnSync('mkfifo', ['--version'], { timeout: 5000 }).status === 0;

test('#464-b2a: a record that’s a FIFO is no consent, refused at once rather than waiting for a writer', { skip: !hasMkfifo && 'no mkfifo here' }, () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'pb-test-record-fifo-'));
  try {
    mkdirSync(join(dataDir, 'remote-installs'), { mode: 0o700 });
    const made = spawnSync('mkfifo', ['-m', '600', join(dataDir, 'remote-installs', 'h1')], { timeout: 5000 });
    assert.equal(made.status, 0, String(made.stderr));
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', READ, dataDir], { encoding: 'utf8', timeout: 10000 });
    assert.equal(r.signal, null, 'the read returned, rather than waiting on the FIFO until the timeout killed it');
    assert.equal(r.status, 0, r.stderr);
    const kept = JSON.parse(r.stdout);
    assert.equal(kept.keepUpdated, false);
    assert.equal(kept.refused, true, 'this version counts as tried');
    assert.equal(typeof kept.error, 'string');
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
