// Installing over a version that’s already on the host (server/remote/install.mjs’s script, #120 L2), with real sh
// and tar: the same code is left as it is, changed files are replaced, and different code is refused while that
// version’s daemon, a turn or an attach starting its daemon is live. No network; nothing touches the real home folder.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { bootId } from '../../server/remote/host/proc.mjs';
import { bundle, installHost } from '../../server/remote/install.mjs';
import { hostPaths } from '../../shared/remote-protocol.mjs';
import { deadPid, HOST, installOnce, liveRecord, localShell, machines, SKIP, top, V, VERSION } from './remote-install-fixtures.mjs';

// ── A version that’s already there ──────────────────────────────────────────────────

test('a second install of the same code says present and leaves the version’s files as they are', { skip: SKIP }, () => {
  const m = machines();
  try {
    const { tar } = bundle({ version: VERSION });
    assert.equal(installOnce(m, tar).stdout, `installed ${VERSION}\n`);
    const code = join(m.home, '.postbox-remote', VERSION);
    writeFileSync(join(code, 'daemon.log'), 'kept');
    const again = installOnce(m, tar);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(again.stdout, `present ${VERSION}\n`);
    assert.equal(readFileSync(join(code, 'daemon.log'), 'utf8'), 'kept');
  } finally {
    rmSync(m.root, { recursive: true, force: true });
  }
});

test('an installed file that changed is found and replaced when nothing of that version runs', { skip: SKIP }, () => {
  const m = machines();
  try {
    const { tar, files } = bundle({ version: VERSION });
    installOnce(m, tar);
    const root = join(m.home, '.postbox-remote');
    const code = join(root, VERSION);
    const changed = join(code, 'server', 'remote', 'host', 'host.mjs');
    writeFileSync(changed, 'console.log("old code");\n');
    // A daemon and a turn of this version that have exited: their records stay, naming dead processes.
    writeFileSync(join(code, 'daemon.pid'), JSON.stringify({ pid: deadPid(), bootId: bootId(), startTime: 1 }));
    const turn = join(root, 'turns', '00000000-0000-4000-8000-000000000001');
    mkdirSync(turn, { recursive: true });
    writeFileSync(join(turn, 'runner.json'), JSON.stringify({ turn: 'x', version: VERSION, pid: deadPid(), bootId: bootId(), startTime: 1 }));
    const r = installOnce(m, tar);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, `installed ${VERSION}\n`);
    for (const f of files) assert.deepEqual(readFileSync(join(code, f.path)), f.data, f.path);
    assert.ok(!existsSync(join(code, 'daemon.pid')), 'the old folder went, with its stale daemon.pid');
    assert.deepEqual(top(root), [VERSION, 'locks', 'turns'], 'no temporary or old folder is left');
    // Different code under the same version, consistent with its own manifest, is replaced too.
    writeFileSync(changed, 'console.log("other code");\n');
    writeFileSync(join(code, 'manifest.sha256'), `${createHash('sha256').update('console.log("other code");\n').digest('hex')}  server/remote/host/host.mjs\n`);
    assert.equal(installOnce(m, tar).stdout, `installed ${VERSION}\n`);
    assert.deepEqual(readFileSync(changed), files.find((f) => f.path === 'server/remote/host/host.mjs')?.data);
  } finally {
    rmSync(m.root, { recursive: true, force: true });
  }
});

test('different code under a version whose daemon or turn is live is refused, and left as it is', { skip: SKIP }, async () => {
  const m = machines();
  try {
    const { tar } = bundle({ version: VERSION });
    installOnce(m, tar);
    const root = join(m.home, '.postbox-remote');
    const code = join(root, VERSION);
    const manifest = join(code, 'manifest.sha256');
    writeFileSync(manifest, `${readFileSync(manifest, 'utf8')}# another build\n`);
    writeFileSync(join(code, 'daemon.pid'), liveRecord());
    const r = installOnce(m, tar);
    assert.equal(r.status, 75, r.stderr);
    assert.equal(r.stdout, '');
    assert.match(
      r.stderr,
      new RegExp(`Postbox ${VERSION.replaceAll('.', '\\.')} is running on this host with different code; stop its turns, then install again`),
    );
    assert.match(readFileSync(manifest, 'utf8'), /# another build/, 'the running version’s folder is untouched');
    assert.deepEqual(top(root), [VERSION, 'locks']);
    // installHost says so, with the next step.
    await assert.rejects(installHost({ host: HOST, version: VERSION, dataDir: m.data, spawn: localShell(m.env) }), (e) => {
      assert.equal(e.kind, 'failed');
      assert.match(e.message, new RegExp(`Postbox ${V} is running on host\\.example\\.com with different code`));
      assert.match(e.next, /^Stop its turns on host\.example\.com, then install again/);
      return true;
    });
    // A live turn of this version refuses it the same way; one of another version doesn’t.
    rmSync(join(code, 'daemon.pid'));
    const turn = join(root, 'turns', '00000000-0000-4000-8000-000000000002');
    mkdirSync(turn, { recursive: true });
    writeFileSync(join(turn, 'runner.json'), liveRecord({ turn: 'x', version: VERSION }));
    assert.equal(installOnce(m, tar).status, 75);
    writeFileSync(join(turn, 'runner.json'), liveRecord({ turn: 'x', version: '0.9.0' }));
    assert.equal(installOnce(m, tar).stdout, `installed ${VERSION}\n`);
  } finally {
    rmSync(m.root, { recursive: true, force: true });
  }
});

test('different code under a version whose daemon an attach is starting (its start lock, no daemon.pid yet) is refused', { skip: SKIP }, async () => {
  const m = machines();
  try {
    const { tar } = bundle({ version: VERSION });
    installOnce(m, tar);
    const root = join(m.home, '.postbox-remote');
    const code = join(root, VERSION);
    // Other code under the same version, consistent with its own manifest, so only the lock stops its replacement.
    const changed = join(code, 'server', 'remote', 'host', 'host.mjs');
    writeFileSync(changed, 'console.log("old code");\n');
    const manifest = join(code, 'manifest.sha256');
    writeFileSync(manifest, `${createHash('sha256').update('console.log("old code");\n').digest('hex')}  server/remote/host/host.mjs\n`);
    const before = readFileSync(manifest, 'utf8');
    // The start lock, as daemon.mjs’s takeLock makes it: a folder, held while `host serve` starts.
    const lock = hostPaths(m.home, VERSION).lock;
    mkdirSync(lock, { recursive: true, mode: 0o700 });
    const r = installOnce(m, tar);
    assert.equal(r.status, 75, r.stderr);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, new RegExp(`Postbox ${V} is starting on this host; install again in a moment`));
    assert.equal(readFileSync(changed, 'utf8'), 'console.log("old code");\n', 'the starting version’s files are untouched');
    assert.equal(readFileSync(manifest, 'utf8'), before);
    assert.deepEqual(readdirSync(root).sort(), [VERSION, 'locks'], 'no temporary or old folder is left');
    assert.ok(existsSync(lock), 'and the attach’s lock is still its own');
    await assert.rejects(installHost({ host: HOST, version: VERSION, dataDir: m.data, spawn: localShell(m.env) }), (e) => {
      assert.equal(e.kind, 'failed');
      assert.match(e.message, new RegExp(`Postbox ${V} is starting on host\\.example\\.com with different code`));
      assert.match(e.next, /^Install again in a moment/);
      return true;
    });
    // A lock older than LOCK_STALE_MS but not a minute still counts: the script’s age test (find -mmin) is in minutes.
    const ago = (/** @type {number} */ s) => new Date(Date.now() - s * 1000);
    utimesSync(lock, ago(45), ago(45));
    assert.equal(installOnce(m, tar).status, 75);
    // Once the attach drops its lock, nothing of that version runs, and the install replaces it.
    rmSync(lock, { recursive: true });
    assert.equal(installOnce(m, tar).stdout, `installed ${VERSION}\n`);
    assert.deepEqual(top(root), [VERSION, 'locks']);
  } finally {
    rmSync(m.root, { recursive: true, force: true });
  }
});
