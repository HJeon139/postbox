// #1066, #1043’s smaller points from its review: a probe whose shell printed its markers and then exited non-zero is
// kept, since the PATH between them is the login shell’s whatever the rc’s exit trap says; a probe’s time is on a
// monotonic clock, so a clock set back mid-probe can’t make it negative and refused; and placement’s refusal names
// the folders the login shell gave, as the turn’s does (lookedText). The sign-in check’s PATH is in
// tests/remote-daemon-check.test.mjs.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { pathMarkers, probeLoginPath } from '../server/remote/host/login-path.mjs';
import { placement } from '../server/remote/placement.mjs';

const TOKEN = '11111111-2222-4333-8444-555555555555';

/** A fake spawn whose shell prints `out(markers)` and exits with `code`. */
function fakeShell(out, code = 0) {
  return (/** @type {any[]} */ ..._args) => {
    const child = Object.assign(new EventEmitter(), { pid: 4242, stdout: new PassThrough() });
    setImmediate(() => {
      child.stdout.end(out(pathMarkers(TOKEN)));
      child.emit('exit', code, null);
      child.emit('close', code, null);
    });
    return child;
  };
}
const around = (path) => (/** @type {{ start: string, end: string }} */ m) => `\n${m.start}${path}${m.end}\n`;
const probe = (spawnImpl, more = {}) => probeLoginPath({ shell: '/bin/zsh', spawnImpl, newToken: () => TOKEN, ...more });

test('#1066 a shell that printed its PATH between the markers, then exited 7 from an rc’s exit trap, keeps that PATH', async () => {
  const r = await probe(fakeShell(around('/login/bin:/usr/bin'), 7));
  assert.deepEqual({ ok: r.ok, entries: r.ok && r.entries }, { ok: true, entries: ['/login/bin', '/usr/bin'] });
  const none = await probe(fakeShell(() => 'Welcome!\n', 7));
  assert.equal(none.ok, false, 'with no markers, a non-zero exit still fails');
  assert.ok(!none.ok && /7/.test(none.why), !none.ok ? none.why : '');
});

test('#1066 a probe’s time is on a monotonic clock, so setting the clock back mid-probe gives no negative ms', async (t) => {
  const times = [1_000_000, 0];
  t.mock.method(Date, 'now', () => times.shift() ?? 0);
  const r = await probe(fakeShell(around('/login/bin')));
  assert.ok(r.ok && r.ms >= 0, JSON.stringify(r));
});

test('#1066 placement’s refusal for a CLI not found names the folders that came from the login shell', () => {
  const welcome = { harnesses: [{ name: 'codex', path: null, looked: ['/opt/tools/bin', '/usr/local/bin'], fromLogin: 1 }] };
  const rt = {
    s: { hosts: { h1: { id: 'h1', name: 'host.example.com' } } },
    adapters: { names: () => ['codex'], get: () => ({ capabilities: { remote: true } }) },
    hosts: { status: () => ({ welcome }) },
  };
  assert.throws(
    () => placement(rt, { hostId: 'h1' }, 'codex'),
    (e) => {
      assert.match(e.message, /looked in \/opt\/tools\/bin \(from your login shell’s PATH\), then \/usr\/local\/bin\./);
      return true;
    },
  );
});
