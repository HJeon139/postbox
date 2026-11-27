// Asking a host whether each harness there is signed in (server/remote/hosts-signins.mjs, #1608): after each welcome,
// without holding anything up, with the answer in the host’s status as signIns, through the fake daemon
// (tests/fake-daemon.mjs).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SIGNED_WAIT_MS } from '../server/remote/hosts-signins.mjs';
import { createFakeDaemon } from './fake-daemon.mjs';
import { setup, until } from './remote-hosts-fixtures.mjs';

const asked = (s) => s.daemon.received.filter((m) => m.type === 'signins').length;

test('after a welcome the host is asked, and its answer lands in the host’s status as signIns', async () => {
  const daemon = createFakeDaemon({
    autoEnd: false,
    signins: { 'claude-code': { state: 'signed-out' }, 'kiro-cli': { state: 'signed-in', method: 'BuilderId' } },
  });
  const s = setup({ daemon });
  const emitted = [];
  s.mgr.on('status', (_id, st) => emitted.push(st.signIns));
  try {
    await s.mgr.ensureWelcome('h1');
    await until(() => s.mgr.status('h1').signIns !== null, 'the answer');
    assert.equal(asked(s), 1);
    assert.deepEqual(s.mgr.status('h1').signIns, {
      at: s.clock.now(),
      harnesses: [
        { name: 'claude-code', state: 'signed-out' },
        { name: 'kiro-cli', state: 'signed-in', method: 'BuilderId' },
        { name: 'codex', state: 'signed-in' },
      ],
    });
    assert.equal(emitted.at(-1), s.mgr.status('h1').signIns, 'the answer is a status change of its own');
  } finally {
    s.done();
  }
});

test('a welcome isn’t held for the answer, and nothing is known until it comes', async () => {
  const s = setup({ daemon: createFakeDaemon({ autoEnd: false, signins: 'silent' }) });
  try {
    const welcome = await s.mgr.ensureWelcome('h1');
    assert.equal(welcome.home, '/home/user', 'the welcome came while the host hadn’t answered');
    await until(() => asked(s) === 1, 'the asking');
    assert.equal(s.mgr.status('h1').signIns, null);
  } finally {
    s.done();
  }
});

test('a daemon from before signins refuses it, which reads as unknown for each harness it has, at once', async () => {
  const s = setup({ daemon: createFakeDaemon({ autoEnd: false, signins: 'refuse', harnesses: ['claude-code', 'codex'] }) });
  try {
    await s.mgr.ensureWelcome('h1');
    // The test clock never moved, so this is the refusal’s reading, not SIGNED_WAIT_MS running out.
    await until(() => s.mgr.status('h1').signIns !== null, 'the refusal’s reading');
    assert.deepEqual(s.mgr.status('h1').signIns.harnesses, [
      { name: 'claude-code', state: 'unknown' },
      { name: 'codex', state: 'unknown' },
    ]);
  } finally {
    s.done();
  }
});

test('a host that doesn’t answer within SIGNED_WAIT_MS reads as unknown', async () => {
  const s = setup({ daemon: createFakeDaemon({ autoEnd: false, signins: 'silent', harnesses: ['kiro-cli'] }) });
  try {
    s.mgr.need('h1', 'turn:t1');
    await until(() => asked(s) === 1, 'the asking');
    s.clock.advance(SIGNED_WAIT_MS - 1);
    // The answer lands a few ticks after the wait ends: let those pass before saying nothing landed.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(s.mgr.status('h1').signIns, null, 'not before its time');
    s.clock.advance(1);
    await until(() => s.mgr.status('h1').signIns !== null, 'the wait’s end');
    assert.deepEqual(s.mgr.status('h1').signIns.harnesses, [{ name: 'kiro-cli', state: 'unknown' }]);
  } finally {
    s.done();
  }
});

test('each welcome asks once: the same session doesn’t ask again, and a new one does', async () => {
  const s = setup();
  try {
    s.mgr.need('h1', 'turn:t1');
    await until(() => s.mgr.status('h1').signIns !== null, 'the first answer');
    await s.mgr.ensureWelcome('h1');
    s.mgr.release('h1', 'turn:t1');
    s.mgr.need('h1', 'turn:t2');
    assert.equal(asked(s), 1, 'the same session');
    const first = s.mgr.status('h1').signIns;
    s.daemon.drop();
    await until(() => s.ssh.calls.length === 2 && asked(s) === 2, 'asked after the new welcome');
    await until(() => s.mgr.status('h1').signIns !== first, 'the new answer');
  } finally {
    s.done();
  }
});

test('the last answer stands while a new session asks, and forgetting the host forgets it', async () => {
  const daemon = createFakeDaemon({ autoEnd: false, signins: { codex: { state: 'signed-out' } } });
  const s = setup({ daemon });
  try {
    s.mgr.need('h1', 'turn:t1');
    await until(() => s.mgr.status('h1').signIns !== null, 'the first answer');
    const first = s.mgr.status('h1').signIns;
    s.daemon.drop();
    await until(() => s.statuses.at(-1)?.state === 'reconnecting', 'the drop');
    assert.equal(s.mgr.status('h1').signIns, first, 'kept across the drop');
    s.mgr.release('h1', 'turn:t1');
    await s.mgr.forget('h1');
    assert.equal(s.mgr.status('h1').signIns, null);
  } finally {
    s.done();
  }
});

test('a new session keeps the last answer until its own comes', async () => {
  let how = /** @type {any} */ ({ codex: { state: 'signed-out' } });
  const s = setup({ daemon: createFakeDaemon({ autoEnd: false, signins: () => how }) });
  try {
    s.mgr.need('h1', 'turn:t1');
    await until(() => s.mgr.status('h1').signIns !== null, 'the first answer');
    const first = s.mgr.status('h1').signIns;
    how = 'silent';
    s.daemon.drop();
    await until(() => asked(s) === 2, 'the new session’s asking');
    await until(() => s.statuses.at(-1)?.state === 'connected', 'the new welcome');
    assert.equal(s.mgr.status('h1').signIns, first, 'the new session hasn’t answered, so the last answer stands');
  } finally {
    s.done();
  }
});
