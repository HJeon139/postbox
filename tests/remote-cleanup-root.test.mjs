// Cleanup on a remote host (server/remote/host/cleanup.mjs, #120), at ~/.postbox-remote itself: an older version’s
// folder retires once nothing uses it, removeAll deletes the root, and a root or turn folder that’s a link is left
// alone. Over a temp home with a fake process check (tests/remote-cleanup-setup.mjs), as tests/remote-cleanup.test.mjs.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { compareVersions, createCleanup, LOCK_FRESH_MS } from '../server/remote/host/cleanup.mjs';
import { hostPaths, MESSAGE_FILE, TURN_FILES } from '../shared/remote-protocol.mjs';
import { BOOT, DAY, ls, makeTurn, setup, VERSION } from './remote-cleanup-setup.mjs';

test('retirement: the newest daemon deletes an old version’s folder unless a turn, its daemon or an attach still uses it', async () => {
  const s = setup();
  try {
    for (const v of ['0.6.0', '0.7.0', '0.8.0', '0.9.0', VERSION]) mkdirSync(join(s.p.root, v, 'server'), { recursive: true });
    mkdirSync(hostPaths(s.home, '0.6.0').lock, { recursive: true });
    writeFileSync(join(s.p.root, '0.7.0', 'daemon.pid'), JSON.stringify({ pid: 901, bootId: BOOT, startTime: 1 }));
    s.alive.add(901);
    makeTurn(s.p, 'old', { exit: false, pid: 902, version: '0.8.0' });
    s.alive.add(902);
    mkdirSync(join(s.p.root, 'not-a-version'));
    const swept = await s.cleanup.sweep();
    assert.deepEqual(swept.retired, ['0.9.0']);
    assert.deepEqual(swept.skipped.sort(), ['0.6.0', '0.7.0', '0.8.0']);
    assert.deepEqual(ls(s.p.root), ['0.6.0', '0.7.0', '0.8.0', VERSION, 'locks', 'not-a-version', 'token', 'turns'].sort());
    // Once the turn and the daemon are gone and the lock is stale, they go too.
    s.alive.clear();
    s.time.skew = 60_000;
    assert.deepEqual((await s.cleanup.sweep()).retired.sort(), ['0.6.0', '0.7.0', '0.8.0']);
    // An older daemon never retires a newer version, or anything.
    mkdirSync(join(s.p.root, '0.11.0'));
    mkdirSync(join(s.p.root, '0.9.0'));
    assert.deepEqual((await s.cleanup.sweep()).retired, []);
    assert.equal(compareVersions('0.9.0', '0.10.0'), -1);
  } finally {
    s.done();
  }
});

test('retirement: a start lock keeps an old version while its owner is live, however old, or while it’s new with no record', async () => {
  const s = setup();
  try {
    for (const v of ['0.6.0', '0.7.0', '0.8.0', '0.9.0', VERSION]) mkdirSync(join(s.p.root, v, 'server'), { recursive: true });
    /** @param {string} v @param {string | null} owner  its owner record’s text, or none */
    const lock = (v, owner) => {
      const l = hostPaths(s.home, v).lock;
      mkdirSync(l, { recursive: true });
      if (owner !== null) writeFileSync(join(l, 'owner'), owner);
    };
    lock('0.6.0', JSON.stringify({ pid: 911, bootId: BOOT, startTime: 1 }));
    s.alive.add(911);
    lock('0.7.0', JSON.stringify({ pid: 912, bootId: BOOT, startTime: 1 }));
    lock('0.8.0', null);
    lock('0.9.0', '{"pid":');
    const first = await s.cleanup.sweep();
    assert.deepEqual(first.retired.sort(), ['0.7.0', '0.9.0'], 'a dead owner’s lock, or a garbled one, holds nothing');
    assert.deepEqual(first.skipped.sort(), ['0.6.0', '0.8.0']);
    // Long after: the one with no record is stale; the live owner’s still holds.
    s.time.skew = 10 * LOCK_FRESH_MS;
    const later = await s.cleanup.sweep();
    assert.deepEqual(later.retired, ['0.8.0']);
    assert.deepEqual(later.skipped, ['0.6.0']);
    s.alive.clear();
    assert.deepEqual((await s.cleanup.sweep()).retired, ['0.6.0']);
  } finally {
    s.done();
  }
});

test('removeAll deletes ~/.postbox-remote and the turns’ agent files, and signals other versions’ daemons; nothing else in home', async () => {
  const s = setup();
  try {
    writeFileSync(join(s.home, 'keep.txt'), 'mine');
    makeTurn(s.p, 't1');
    const agents = join(s.home, '.kiro', 'agents');
    await s.cleanup.writeAgentFile('t1', { dir: agents, name: 'p.json', text: '{}' });
    mkdirSync(join(s.p.root, '0.9.0'), { recursive: true });
    writeFileSync(join(s.p.root, '0.9.0', 'daemon.pid'), JSON.stringify({ pid: 901, bootId: BOOT, startTime: 1 }));
    s.alive.add(901);
    const signaled = [];
    await s.cleanup.removeAll((pid) => signaled.push(pid));
    assert.deepEqual(signaled, [901]);
    assert.ok(!existsSync(s.p.root));
    assert.ok(!existsSync(join(agents, 'p.json')));
    assert.deepEqual(ls(s.home), ['.kiro', 'keep.txt']);
  } finally {
    s.done();
  }
});

test('a ~/.postbox-remote that’s a link is refused: removeAll and the sweep delete nothing, inside or outside it', async () => {
  const home = mkdtempSync(join(tmpdir(), 'pbc-'));
  try {
    const elsewhere = join(home, 'elsewhere');
    const p = hostPaths(home, VERSION);
    mkdirSync(join(elsewhere, 'turns'), { recursive: true });
    writeFileSync(join(elsewhere, 'precious'), 'x');
    symlinkSync(elsewhere, p.root);
    makeTurn(p, 't1');
    const logs = [];
    const cleanup = createCleanup({
      home,
      version: VERSION,
      paths: p,
      log: (l) => logs.push(l),
      settings: () => ({ logRetention: 1, logMaxBytes: 1 }),
      sameProcess: () => false,
    });
    await assert.rejects(
      cleanup.removeAll(() => {}),
      /isn’t a folder \(it’s a link or a file\)/,
    );
    assert.deepEqual((await cleanup.sweep()).folders, []);
    await cleanup.turnEnded('t1');
    assert.ok(existsSync(join(elsewhere, 'precious')));
    assert.ok(existsSync(join(elsewhere, 'turns', 't1', MESSAGE_FILE)), 'nothing in the linked folder was touched');
    assert.match(logs.join('\n'), /won’t delete anything/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a turn folder that’s a link is skipped: nothing it points at is deleted', async () => {
  const s = setup();
  try {
    const target = join(s.home, 'work');
    mkdirSync(target);
    writeFileSync(join(target, TURN_FILES.out), 'mine\n');
    writeFileSync(join(target, TURN_FILES.exit), '{"code":0,"signal":null,"at":1}');
    writeFileSync(join(target, MESSAGE_FILE), 'mine');
    symlinkSync(target, s.p.turn('t1'));
    s.time.skew = 30 * DAY;
    await s.cleanup.sweep();
    await s.cleanup.ack('t1', 5);
    assert.deepEqual(ls(target), [TURN_FILES.exit, MESSAGE_FILE, TURN_FILES.out].sort());
  } finally {
    s.done();
  }
});
