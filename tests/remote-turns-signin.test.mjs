// The warning before a turn starts on a host (server/remote/turns-signin.mjs): when the host last said the turn’s
// harness isn’t signed in (#1608), the person hears so with the command to run there, and the turn still starts.
// tests/remote-turns.test.mjs says how the rig works.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HOST, rig, running, settled, starts } from './remote-turns-helpers.mjs';

/** The host’s last answer, as the manager’s status carries it. @param {object[]} harnesses */
const signIns = (harnesses) => ({ at: 1, harnesses });

/** The sign-in notices the turn raised. @param {ReturnType<typeof rig>} r */
const signInNotes = (r) => r.notes.filter((n) => /sign/i.test(`${n.title} ${n.text}`));

test('#1608: a harness the host said is signed out warns before the turn, naming the command, and the turn still runs', async () => {
  const r = rig();
  r.hosts.signIns = signIns([{ name: 'claude-code', state: 'signed-out' }]);
  const turn = await running(r);
  assert.equal(starts(r.d).length, 1, 'a notice, never a refusal');
  const notes = signInNotes(r);
  assert.deepEqual(
    notes.map((n) => n.title),
    [`Claude Code on ${HOST} isn’t signed in`],
  );
  assert.match(notes[0].text, /Run “claude auth login” on host\.example\.com/);
  r.d.end(turn);
  await settled(r);
});

test('#1608: signed in, unknown, or another harness signed out raises no sign-in notice', async () => {
  for (const harnesses of [
    [{ name: 'claude-code', state: 'signed-in', method: 'claude.ai', expiresAt: null }],
    [{ name: 'claude-code', state: 'unknown' }],
    [{ name: 'codex', state: 'signed-out' }],
  ]) {
    const r = rig();
    r.hosts.signIns = signIns(harnesses);
    const turn = await running(r);
    assert.deepEqual(signInNotes(r), [], JSON.stringify(harnesses));
    r.d.end(turn);
    await settled(r);
  }
});

test('#1608: a harness signed out and a failed signInCheck give one notice, the one with the command', async () => {
  const r = rig({ signIn: { ok: false, code: 1, at: 1 } });
  r.hosts.signIns = signIns([{ name: 'claude-code', state: 'signed-out' }]);
  const turn = await running(r);
  assert.deepEqual(
    signInNotes(r).map((n) => n.title),
    [`Claude Code on ${HOST} isn’t signed in`],
  );
  r.d.end(turn);
  await settled(r);
});

test('#1608: a turn’s start warns from what the host says now, not from an answer before it', async () => {
  // Signed out when last asked, signed in since: no notice.
  const fixed = rig();
  fixed.hosts.signIns = signIns([{ name: 'claude-code', state: 'signed-out' }]);
  fixed.hosts.signInsNow = async () => signIns([{ name: 'claude-code', state: 'signed-in', method: 'claude.ai', expiresAt: null }]);
  const one = await running(fixed);
  assert.deepEqual(signInNotes(fixed), [], 'a sign-in fixed since raises nothing');
  fixed.d.end(one);
  await settled(fixed);
  // Signed in when last asked, signed out since: the notice.
  const lapsed = rig();
  lapsed.hosts.signIns = signIns([{ name: 'claude-code', state: 'signed-in', method: 'claude.ai', expiresAt: null }]);
  lapsed.hosts.signInsNow = async () => signIns([{ name: 'claude-code', state: 'signed-out' }]);
  const two = await running(lapsed);
  assert.deepEqual(
    signInNotes(lapsed).map((n) => n.title),
    [`Claude Code on ${HOST} isn’t signed in`],
  );
  lapsed.d.end(two);
  await settled(lapsed);
});
