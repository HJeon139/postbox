// This Postbox’s name for its hosts’ daemons (#120; server/remote/hosts-status.mjs, instanceOf): made once in the data
// folder, 0600, and the same after a restart, so a host can let it replace its own stale connection.

import assert from 'node:assert/strict';
import { chmodSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { instanceOf } from '../server/remote/hosts-status.mjs';
import { INSTANCE_FILE } from '../server/remote/install-token.mjs';
import { setup } from './remote-hosts-fixtures.mjs';

test('#120 a Postbox’s name is made once in its data folder, 0600, and read back after a restart', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'pb-instance-'));
  try {
    const m = /** @type {any} */ ({ dataDir });
    const id = instanceOf(m);
    assert.match(String(id), /^[0-9a-f]{32}$/);
    assert.equal(instanceOf(m), id);
    const file = join(dataDir, INSTANCE_FILE);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(instanceOf(/** @type {any} */ ({ dataDir })), id, 'the same after a restart');
    // A file that doesn’t hold a name is replaced by one.
    writeFileSync(file, 'x\n');
    const again = instanceOf(/** @type {any} */ ({ dataDir }));
    assert.match(String(again), /^[0-9a-f]{32}$/);
    assert.equal(readFileSync(file, 'utf8').trim(), again);
    assert.equal(instanceOf(/** @type {any} */ ({ dataDir: '' })), null, 'none without a data folder');
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('#120 a link where the name goes is replaced itself, never written through, and a name readable by others is made 0600', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'pb-instance-'));
  try {
    const file = join(dataDir, INSTANCE_FILE);
    const target = join(dataDir, 'someone-elses.txt');
    writeFileSync(target, 'keep me\n');
    symlinkSync(target, file);
    const id = instanceOf(/** @type {any} */ ({ dataDir }));
    assert.match(String(id), /^[0-9a-f]{32}$/);
    assert.equal(readFileSync(target, 'utf8'), 'keep me\n', 'the link’s target is untouched');
    assert.ok(lstatSync(file).isFile(), 'the link itself was replaced by a file');
    assert.equal(lstatSync(file).mode & 0o777, 0o600);
    // A name another start left 0644 is kept, and made 0600.
    chmodSync(file, 0o644);
    assert.equal(instanceOf(/** @type {any} */ ({ dataDir })), id);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(dataDir).sort(), [INSTANCE_FILE, 'someone-elses.txt'].sort(), 'no temporary file left');
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('#120 the host manager’s hello names this Postbox, as its data folder keeps it', async () => {
  const s = setup();
  try {
    await s.mgr.connect('h1');
    const hello = s.daemon.received.find((m) => m.type === 'hello');
    assert.equal(hello?.instance, readFileSync(join(s.dataDir, INSTANCE_FILE), 'utf8').trim());
  } finally {
    s.done();
  }
});
