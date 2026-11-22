// #1059: a host question whose call the host ends: what the agent still gets, what it no longer counts as, and that
// nothing waits on it afterwards. Moved from tests/remote-turns-question.test.mjs unchanged.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { messageOf, rig, running, settled, starts, until } from './remote-turns-helpers.mjs';
import { callLine, ONE, pick, questions, request, TWO } from './remote-turns-question-fixture.mjs';

test('#1059 a two-question call the host ends while its second block waits leaves nothing waiting, and counts as ended', async () => {
  const r = rig();
  const turn = await running(r);
  r.d.append(turn, callLine(TWO));
  const id = r.d.prompt(turn, request(TWO));
  await until(() => questions(r).length === 1, 'the first block');
  pick(r, questions(r)[0], 'Blue');
  await until(() => questions(r).length === 2 && r.rt.permissionWaits.has(questions(r)[1].id), 'the second block, waiting');
  r.d.expire(turn, id);
  await until(() => !questions(r).some((q) => r.rt.permissionWaits.has(q.id)), 'no wait left');
  await until(() => r.se().remoteTurn?.state === 'running', 'the turn no longer waiting on the person');
  assert.ok(
    questions(r).every((q) => q.remote.ended),
    'each block records the end, so the prompt no longer counts as open',
  );
  const before = starts(r.d).length;
  r.d.end(turn);
  // The first answer reaches the agent as a message, which wakes it.
  await until(() => starts(r.d).length > before, 'the agent’s next turn');
  r.d.end(starts(r.d).at(-1).turn);
  await settled(r);
});

test('#1059 a two-question call the host ends after the first answer: the agent still gets that answer', async () => {
  const r = rig();
  const turn = await running(r);
  r.d.append(turn, callLine(TWO));
  const id = r.d.prompt(turn, request(TWO));
  await until(() => questions(r).length === 1, 'the first block');
  pick(r, questions(r)[0], 'Red');
  await until(() => questions(r).length === 2 && r.rt.permissionWaits.has(questions(r)[1].id), 'the second block, waiting');
  r.d.expire(turn, id);
  await until(() => !questions(r).some((q) => r.rt.permissionWaits.has(q.id)), 'no wait left');
  const before = starts(r.d).length;
  r.d.end(turn);
  // The person’s first answer went to the call that ended, so it comes to the agent as a message, as a late answer does.
  await until(() => starts(r.d).length > before, 'the agent’s next turn');
  assert.match(messageOf(starts(r.d).at(-1)), /Which color\?[\s\S]*Red/);
  assert.equal(r.rt.delivery.entriesFrom(questions(r)[0].id).length, 1, 'once');
  r.d.end(starts(r.d).at(-1).turn);
  await settled(r);
});

test('#1059 a two-question call the host ends before the second was shown: it’s shown, and stays answerable', async () => {
  const r = rig();
  const turn = await running(r);
  r.d.append(turn, callLine(TWO));
  const id = r.d.prompt(turn, request(TWO));
  await until(() => questions(r).length === 1 && r.rt.permissionWaits.has(questions(r)[0].id), 'the first block, waiting');
  r.d.expire(turn, id);
  await until(() => questions(r).length === 2, 'the second question, shown as well');
  const second = questions(r)[1];
  assert.equal(second.block.prompt, 'Which fruits?');
  assert.equal(r.rt.permissionWaits.has(second.id), false, 'nothing waits on it: its answer comes as a message');
  r.d.end(turn);
  await settled(r);
  const before = starts(r.d).length;
  pick(r, second, 'Plum');
  await until(() => starts(r.d).length > before, 'the agent’s next turn');
  assert.match(messageOf(starts(r.d).at(-1)), /Which fruits\?[\s\S]*Plum/);
  r.d.end(starts(r.d).at(-1).turn);
  await settled(r);
});

test('#1059 an ended question no longer counts as open: a prompt-expired naming no prompt ends the lone card beside it', async () => {
  const r = rig();
  const turn = await running(r);
  r.d.append(turn, callLine(ONE));
  const q = r.d.prompt(turn, request(ONE));
  await until(() => questions(r).length === 1, 'the question’s block');
  r.d.expire(turn, q);
  await until(() => questions(r)[0].remote?.ended, 'the question ended');
  // An ordinary permission card for the same host turn, then an old daemon’s expiry that names no prompt.
  r.d.prompt(turn);
  const card = () => r.store.items(r.t.id).find((i) => i.kind === 'permission' && i.remote?.turn === turn);
  await until(() => card()?.status === 'open', 'the card');
  r.link.hear({ type: 'error', code: 'internal', re: 'prompt-expired', turn, message: 'Couldn’t write down that a prompt ended.' });
  await until(() => card().status !== 'open', 'the lone open card ended');
  r.d.end(turn);
  await settled(r);
});
