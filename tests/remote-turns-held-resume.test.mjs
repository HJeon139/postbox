// A remote turn interrupted while a commit is held (#623, designs/508/601-held-view.md, “a read that decides a write
// reads pending”): its Interrupted state and its resume are pending, not published, so a decision read from the
// published session doesn’t resume it, loses a resume’s count, or gives it up as if it were still on the host. The rig
// is tests/remote-turns-held-fixture.mjs, as tests/remote-turns-held.test.mjs uses it.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { heldRig, remoteTurn } from './remote-turns-held-fixture.mjs';
import { running, settled, signInLines, starts, until } from './remote-turns-helpers.mjs';

/** A rig whose turn runs on the host, with the host away so an interruption waits for it, and a session ID. */
async function awayRig() {
  const r = await heldRig();
  const turn = await running(r);
  await until(() => r.se().backendState?.claudeSessionId, 'the session ID');
  r.hosts.state = 'reconnecting';
  return { r, turn };
}

test('a turn interrupted behind a held commit resumes once the host is back, and both resumes are counted (#623, autoResume)', async () => {
  const { r, turn } = await awayRig();
  const release = await r.hold();
  r.d.interrupt(turn);
  await settled(r);
  r.hosts.state = null;
  r.hosts.emit('status', r.host.id, { state: 'connected' });
  await until(() => starts(r.d).length === 2 && r.d.turns.has(starts(r.d)[1].turn), 'the first resume');
  await until(() => r.d.received.some((m) => m.type === 'read' && m.turn === starts(r.d)[1].turn), 'the first resume to be read');
  r.d.interrupt(starts(r.d)[1].turn);
  await until(() => starts(r.d).length === 3, 'the second resume');
  await release();
  assert.equal(remoteTurn(r).autoResumes, 2, 'both resumes are counted, so a turn interrupted again and again waits for the person');
  r.d.end(starts(r.d)[2].turn);
  await settled(r);
  await r.close();
});

test('giving up a turn interrupted behind a held commit drops its resume, and asks its host to stop nothing (#623, cancel)', async () => {
  const { r, turn } = await awayRig();
  const release = await r.hold();
  r.d.interrupt(turn);
  await settled(r);
  r.rt.remote.cancel(r.se().id);
  await release();
  assert.equal(remoteTurn(r).resume, null, 'nothing resumes for a conversation put away');
  assert.equal(remoteTurn(r).state, 'done');
  assert.deepEqual(remoteTurn(r).stopping ?? [], [], 'its runner is gone, so there is no stop to wait on');
  assert.deepEqual(r.d.stops, [], 'no stop was sent to the host for a turn that isn’t there');
  await r.close();
});

test('a turn that needs sign-in behind a held commit resumes once the host’s check passes (#623, tick, trySignInResume)', async () => {
  const r = await heldRig({ daemon: { lines: signInLines() }, signIn: { ok: true, code: 0, at: 1 } });
  const release = await r.hold();
  const turn = await running(r);
  r.d.end(turn, { code: 1, signal: null });
  await settled(r);
  r.rt.remote.tick();
  await until(() => starts(r.d).length === 2, 'the resumed turn');
  await release();
  assert.equal(remoteTurn(r).state, 'running', 'the check passed, so the turn goes on');
  r.d.end(starts(r.d)[1].turn);
  await settled(r);
  await r.close();
});
