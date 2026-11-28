// The warning before a turn starts on a host (server/remote/turns-signin.mjs): when the host, asked as the turn starts,
// says the turn’s harness isn’t signed in (#1608), the person hears so with the command to run there, and the turn
// starts without waiting for the answer. tests/remote-turns.test.mjs says how the rig works.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { warnSignIn } from '../server/remote/turns-signin.mjs';
import { BACKEND_NAMES } from '../shared/agent-facts.mjs';
import { HOST, rig, running, settled, sleep, starts, until } from './remote-turns-helpers.mjs';

/** The host’s answer, as the manager’s status carries it. @param {object[]} harnesses */
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

/** An asking the test answers when it likes: signInsNow, and resolve or reject for its answer. */
function deferred() {
  /** @type {(v: any) => void} */
  let resolve = () => {};
  /** @type {(e: any) => void} */
  let reject = () => {};
  const p = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { signInsNow: () => p, resolve, reject };
}

test('#1608: the start reaches the host while the host’s answer is pending, and a sign-out heard after warns', async () => {
  const r = rig();
  const answer = deferred();
  r.hosts.signInsNow = answer.signInsNow;
  // A slow status command on the host holds nothing: the start goes out before any answer (the review of #1957).
  r.rt.sendMessage(r.t.id, { text: 'hi' });
  await until(() => starts(r.d).length === 1, 'the start before the host’s answer', 250);
  assert.deepEqual(signInNotes(r), [], 'nothing said before the answer');
  answer.resolve(signIns([{ name: 'claude-code', state: 'signed-out' }]));
  await until(() => signInNotes(r).length === 1, 'the notice once the answer comes');
  assert.equal(signInNotes(r)[0].title, `Claude Code on ${HOST} isn’t signed in`);
  r.d.end(starts(r.d)[0].turn);
  await settled(r);
});

test('#1608: a turn stopped before the host’s answer comes raises no sign-in notice', async () => {
  const r = rig();
  const answer = deferred();
  r.hosts.signInsNow = answer.signInsNow;
  r.rt.sendMessage(r.t.id, { text: 'hi' });
  await until(() => starts(r.d).length === 1, 'the start before the host’s answer', 250);
  r.rt.stop(r.se().id, { by: 'you' });
  await settled(r);
  answer.resolve(signIns([{ name: 'claude-code', state: 'signed-out' }]));
  await sleep(20);
  assert.deepEqual(signInNotes(r), [], 'a stopped turn hears nothing of its host’s sign-in');
});

test('#1608: an asking that fails starts the turn, raises no sign-out notice, and leaves no unhandled rejection', async () => {
  /** @type {unknown[]} */
  const unhandled = [];
  const onUnhandled = (/** @type {unknown} */ e) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    // Without a signInCheck, nothing at all; with a failed one, its own notice, as when the host says nothing.
    for (const [signIn, titles] of [
      [null, []],
      [{ ok: false, code: 1, at: 1 }, [`Sign-in on ${HOST} may have run out`]],
    ]) {
      const r = rig({ signIn });
      r.hosts.signInsNow = async () => {
        throw new Error('the link failed');
      };
      const turn = await running(r);
      await sleep(20);
      assert.equal(starts(r.d).length, 1);
      assert.deepEqual(
        signInNotes(r).map((n) => n.title),
        titles,
      );
      r.d.end(turn);
      await settled(r);
    }
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('#1608: two turn starts on a host that get the same signed-out answer raise one notice, and a new answer another', async () => {
  const r = rig();
  r.hosts.signIns = signIns([{ name: 'claude-code', state: 'signed-out' }]);
  for (const at of [1, 1, 2]) {
    r.hosts.signIns = { ...r.hosts.signIns, at };
    const turn = await running(r);
    await sleep(10);
    r.d.end(turn);
    await settled(r);
  }
  assert.equal(signInNotes(r).length, 2, 'once for the answer at 1, once for the answer at 2');
});

test('#1608: each harness’s notice names its own login command', async () => {
  for (const [backend, command] of [
    ['claude-code', 'claude auth login'],
    ['codex', 'codex login'],
    ['kiro-cli', 'kiro-cli login'],
  ]) {
    /** @type {string[][]} */
    const notes = [];
    const rts = /** @type {any} */ ({
      hosts: { signInCheck: async () => null, signInsNow: async () => signIns([{ name: backend, state: 'signed-out' }]) },
      rt: { threads: { notify: (/** @type {string[]} */ ...a) => notes.push(a) } },
      now: () => 0,
    });
    const turn = { remote: { hostId: `ho-${backend}` }, threadId: 'th' };
    const ctx = { signal: new AbortController().signal, persona: { backend } };
    await warnSignIn(rts, turn, ctx, { handle: 'coder' }, { name: HOST });
    await until(() => notes.length > 0, `the ${backend} notice`);
    assert.equal(notes.length, 1, backend);
    assert.equal(notes[0][2], `${BACKEND_NAMES[backend]} on ${HOST} isn’t signed in`);
    assert.ok(notes[0][3].includes(`Run “${command}” on ${HOST}`), `${backend}: ${notes[0][3]}`);
  }
});

test('#1608: a turn stopped during signInCheck asks the host nothing of its sign-ins and never starts', async () => {
  const r = rig();
  /** @type {(v: any) => void} */
  let answerCheck = () => {};
  let checking = false;
  r.hosts.signInCheck = () => {
    checking = true;
    return new Promise((res) => {
      answerCheck = res;
    });
  };
  let asked = 0;
  r.hosts.signInsNow = async () => {
    asked++;
    return signIns([{ name: 'claude-code', state: 'signed-out' }]);
  };
  r.rt.sendMessage(r.t.id, { text: 'hi' });
  await until(() => checking, 'the sign-in check');
  r.rt.stop(r.se().id, { by: 'you' });
  answerCheck({ ok: false, code: 1, at: 1 });
  await settled(r);
  await sleep(20);
  assert.equal(asked, 0, 'no asking for a turn already stopped');
  assert.equal(starts(r.d).length, 0);
  assert.deepEqual(signInNotes(r), []);
});

test('#1608: a notice that throws as it’s raised is caught, not left as an unhandled rejection, and told again', async () => {
  /** @type {unknown[]} */
  const unhandled = [];
  const onUnhandled = (/** @type {unknown} */ e) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  const errors = [];
  const { error } = console;
  console.error = (/** @type {unknown[]} */ ...a) => errors.push(a.join(' '));
  let told = 0;
  const answer = signIns([{ name: 'codex', state: 'signed-out' }]);
  try {
    const rts = /** @type {any} */ ({
      hosts: { signInCheck: async () => null, signInsNow: async () => answer },
      rt: {
        threads: {
          notify: () => {
            told += 1;
            if (told === 1) throw new Error('the store refused it');
          },
        },
      },
      now: () => 0,
    });
    const ctx = { signal: new AbortController().signal, persona: { backend: 'codex' } };
    await warnSignIn(rts, { remote: { hostId: 'ho-throws' }, threadId: 'th' }, ctx, { handle: 'coder' }, { name: HOST });
    await until(() => errors.length > 0, 'the failure said');
    await sleep(10);
    assert.match(errors[0], /the store refused it/);
    assert.deepEqual(unhandled, []);
    await warnSignIn(rts, { remote: { hostId: 'ho-throws' }, threadId: 'th' }, ctx, { handle: 'coder' }, { name: HOST });
    await until(() => told === 2, 'the same answer told again, since the first telling failed');
  } finally {
    console.error = error;
    process.off('unhandledRejection', onUnhandled);
  }
});
