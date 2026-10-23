// Cleanup on a remote host (server/remote/host/cleanup.mjs, #120), for real: the in-process daemon with its own runner
// functions drives the real runner.mjs on the stand-in harness (tests/fixtures/remote/harness.mjs), and proc.mjs’s
// sameProcess checks real processes, in a temp POSTBOX_REMOTE_HOME (tests/integration/host.mjs). The rules themselves,
// with fakes, are in tests/remote-cleanup.test.mjs.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { bootId, startTime } from '../../server/remote/host/proc.mjs';
import { gone, HARNESS, makeHost, NO_UNIX, realDaemon, TURN, until } from './host.mjs';

test('remove: a running turn’s runner is stopped and gone before ~/.postbox-remote is deleted, then removed', { skip: NO_UNIX }, async () => {
  const h = makeHost();
  let removed = false;
  const d = realDaemon(h, { onRemoved: () => (removed = true), stopGraceMs: 2000 });
  try {
    writeFileSync(join(h.home, 'keep.txt'), 'mine');
    await d.daemon.start();
    const c = d.connect();
    await c.msgs.next('welcome', 5000);
    c.send('start', { turn: TURN, harness: 'claude-code', folder: h.work, argv: [HARNESS, 'out:ready', 'sleep:60000'], env: {}, stdin: 'none', files: [] });
    await c.msgs.next('started', 10_000);
    const runner = JSON.parse(readFileSync(h.p.turn(TURN, 'runner.json'), 'utf8'));
    c.send('remove', {});
    await c.msgs.next('removed', 15_000);
    assert.ok(gone(runner.pid), 'the runner ended before the folder went');
    assert.ok(!existsSync(h.p.root));
    assert.ok(existsSync(join(h.home, 'keep.txt')), 'nothing else in the home folder');
    await until(() => removed, 'the daemon to exit');
  } finally {
    d.close();
    rmSync(h.home, { recursive: true, force: true });
  }
});

test('retirement: an old version whose daemon.pid names a live process stays; once it names a dead one, it goes', { skip: NO_UNIX }, async () => {
  const h = makeHost();
  const d = realDaemon(h);
  try {
    const old = join(h.p.root, '0.0.1');
    mkdirSync(join(old, 'server'), { recursive: true });
    // This test’s own process stands in for the old version’s daemon.
    writeFileSync(join(old, 'daemon.pid'), JSON.stringify({ pid: process.pid, bootId: bootId(), startTime: startTime(process.pid) }));
    assert.deepEqual((await d.daemon.cleanup.sweep()).skipped, ['0.0.1']);
    assert.ok(existsSync(old));
    writeFileSync(join(old, 'daemon.pid'), JSON.stringify({ pid: process.pid, bootId: bootId(), startTime: (startTime(process.pid) ?? 0) + 1 }));
    assert.deepEqual((await d.daemon.cleanup.sweep()).retired, ['0.0.1']);
    assert.ok(!existsSync(old));
    assert.ok(existsSync(h.p.token));
  } finally {
    d.close();
    rmSync(h.home, { recursive: true, force: true });
  }
});
