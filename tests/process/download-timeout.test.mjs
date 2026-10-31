// The Redis download’s time limit keeps Node’s event loop alive (server/redis-download.mjs). AbortSignal.timeout’s
// timer doesn’t, so a download whose request never answered, with nothing else pending, ended the process before the
// limit fired: on CI’s Linux runner the download test was cancelled with “Promise resolution is still pending but the
// event loop has already resolved” (#553’s check run on 541c0cd6). The limit is a plain timer now, cleared when the
// download ends either way.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const CHILD = fileURLToPath(new URL('./download-timeout-child.mjs', import.meta.url));

test('a Node whose only wait is a download that never answers stays up until the time limit gives it up', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pb-dl-'));
  try {
    const r = await new Promise((ok) => {
      const p = spawn(process.execPath, [CHILD, dir], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (err += d));
      p.on('exit', (code) => ok({ code, out, err }));
    });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /settled: EDOWNLOAD/);
    assert.doesNotMatch(r.err, /unsettled top-level await/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
