// #1562: the listing folder’s diagnostics name a process that holds a file there, so “processes: none” means none.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { tempDir } from '../temp-dirs.mjs';
import { holders, removeListing, writers } from './listing-folder.mjs';

test('#1562 a process holding a file in the folder is named, by its pid and command; none is named once it’s gone', async () => {
  const dir = tempDir('pb-listing-holder-');
  mkdirSync(join(dir, 'sessions'));
  writeFileSync(join(dir, 'sessions', 'held.json'), '{}');
  // The path goes in on stdin, so neither the child’s command line nor its environment names the folder: only the
  // file it holds open does, as with a process the CLI started that writes there.
  const script = `let p = ''; process.stdin.on('data', (d) => { p += d; if (p.endsWith('\\n')) { require('node:fs').openSync(p.trim(), 'r'); console.log('held'); } }); setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'ignore'] });
  child.stdin.write(`${join(dir, 'sessions', 'held.json')}\n`);
  try {
    await once(child.stdout, 'data');
    const held = holders(dir);
    assert.ok(held.ok && held.found.some((h) => h.startsWith(`${child.pid} `)), `lsof names ${child.pid}: ${JSON.stringify(held)}`);
    assert.match(writers(dir, Date.now()), new RegExp(`processes: .*${child.pid} `));
  } finally {
    child.kill('SIGKILL');
    await once(child, 'close');
  }
  assert.deepEqual(holders(dir), { ok: true, found: [] }, 'and none once it has exited');
  assert.ok(existsSync(dir));
});

test('#1562 an lsof that can’t run, or fails, is reported as unknown, never as “processes: none”', () => {
  const dir = tempDir('pb-listing-noprobe-');
  writeFileSync(join(dir, 'a.json'), '{}');
  const missing = holders(dir, { lsof: join(dir, 'no-such-lsof') });
  assert.equal(missing.ok, false, JSON.stringify(missing));
  assert.match(writers(dir, Date.now(), { lsof: join(dir, 'no-such-lsof') }), /processes: unknown: lsof couldn’t run/);
  // An lsof that exits 2, as one refused permission does, says nothing about who holds the files.
  const failing = join(dir, 'failing-lsof');
  writeFileSync(failing, '#!/bin/sh\necho "lsof: permission denied" >&2\nexit 2\n');
  chmodSync(failing, 0o755);
  assert.match(writers(dir, Date.now(), { lsof: failing }), /processes: unknown: lsof exited 2/);
});

test('#1562 the removal still retries when describing the folder throws', async (t) => {
  const dir = tempDir('pb-listing-throws-');
  const locked = join(dir, 'locked');
  mkdirSync(locked);
  writeFileSync(join(locked, 'f.json'), '{}');
  // A folder without write permission can’t be emptied, so the first removal fails; restoring it lets the retry pass.
  chmodSync(locked, 0o500);
  let described = 0;
  removeListing(t, dir, Date.now(), () => {
    described += 1;
    chmodSync(locked, 0o700);
    throw new Error('lsof hung');
  });
  assert.equal(described, 1, 'the first removal failed, so the folder was described');
  assert.equal(existsSync(dir), false, 'and the retry removed it anyway');
});
