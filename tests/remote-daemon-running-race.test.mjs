// Two looks at a silent host runner that cross (server/remote/host/daemon-running.mjs, #872): each look takes a
// number, so a miss that comes back after a later look got an answer starts no silence, and an answer that comes
// back after a later look’s miss doesn’t end the silence that miss began. Through two scans, in-process with fake
// runners and a fake clock (tests/remote-daemon-running-setup.mjs).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { silentSetup } from './remote-daemon-running-setup.mjs';
import { hello, startMsg, waitFor } from './remote-daemon-setup.mjs';

/**
 * t1 started with no reader, then two scans: the slow one’s look answers `first` only once finish() releases it,
 * after the fast one’s look, which answers `later`, has come back.
 */
async function crossing({ first, later }) {
  /** @type {null | ((v?: unknown) => void)} */
  let release = null;
  let racing = false;
  let n = 0;
  const s = silentSetup({
    answer: () => {
      if (!racing) return true;
      if (++n > 1) return later;
      return new Promise((r) => {
        release = r;
      }).then(() => first);
    },
  });
  const c = await hello(s);
  c.send('start', startMsg('t1'));
  await c.msgs.next('started');
  racing = true;
  const slow = s.daemon.scan();
  await waitFor(() => release !== null);
  const fast = await s.daemon.scan();
  const finish = async () => {
    release?.();
    return slow;
  };
  return { s, fast, finish };
}

test('#872 a miss that comes back after a later look’s answer starts no silence', async () => {
  const { s, fast, finish } = await crossing({ first: false, later: true });
  try {
    assert.equal(fast[0].state, 'running');
    assert.equal((await finish())[0].state, 'running');
    assert.equal(s.daemon.silentSince.has('t1'), false, 'no silence after the answer');
    assert.equal(s.logs.filter((l) => /t1.*didn’t answer/.test(l)).length, 0);
  } finally {
    s.done();
  }
});

test('#872 an answer that comes back after a later look’s miss doesn’t end the silence that miss began', async () => {
  const { s, fast, finish } = await crossing({ first: true, later: false });
  try {
    assert.equal(fast[0].state, 'running');
    assert.ok(s.daemon.silentSince.has('t1'), 'the later look began a silence');
    await finish();
    assert.ok(s.daemon.silentSince.has('t1'), 'the earlier look’s answer is older news');
    assert.equal(s.logs.filter((l) => /t1.*answered again/.test(l)).length, 0);
  } finally {
    s.done();
  }
});
