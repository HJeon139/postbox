// #1562: the listing folder’s diagnostics name a process that holds a file there, so “processes: none” means none.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { tempDir } from '../temp-dirs.mjs';
import { holders, writers } from './listing-folder.mjs';

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
    assert.ok(
      holders(dir).some((h) => h.startsWith(`${child.pid} `)),
      `lsof names ${child.pid}: ${holders(dir).join(', ')}`,
    );
    assert.match(writers(dir, Date.now()), new RegExp(`processes: .*${child.pid} `));
  } finally {
    child.kill('SIGKILL');
    await once(child, 'close');
  }
  assert.deepEqual(holders(dir), [], 'and none once it has exited');
  assert.ok(existsSync(dir));
});
