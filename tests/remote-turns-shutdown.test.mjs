// The runtime’s remote turns as Postbox shuts down (#120; tests/remote-turns.test.mjs says how): a prompt the person
// answers while the host manager closes its links neither crashes Postbox nor loses the answer, which the card keeps
// and the next start sends when the daemon asks again.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FIXTURE_PROMPT } from './fake-daemon.mjs';
import { rig, running, settled, sleep, startUp, until } from './remote-turns-helpers.mjs';

test('#120: a prompt answered while the host manager closes doesn’t crash, and the next start sends its answer', async () => {
  const rejections = [];
  const onRejection = (/** @type {unknown} */ e) => rejections.push(e);
  process.on('unhandledRejection', onRejection);
  try {
    const first = rig();
    const turn = await running(first);
    const id = first.d.prompt(turn);
    await until(() => first.store.items(first.t.id).some((i) => i.kind === 'permission'), 'the card');
    const card = first.store.items(first.t.id).find((i) => i.kind === 'permission');

    // Postbox shuts down: the turns let go of the host, then the manager closes its links and refuses link(), as
    // server/remote/hosts-links.mjs does once it’s closed.
    await first.rt.stopTurns({ graceMs: 0 });
    first.link.connected = false;
    first.hosts.link = () => {
      throw Object.assign(new Error('Postbox has closed its host connections.'), { code: 'closed' });
    };
    first.rt.resolvePermission(first.t.id, card.id, 'allow');
    await sleep(20);
    assert.deepEqual(rejections, [], 'nothing thrown out of the answer');
    assert.equal(first.d.answers.length, 0, 'no link to send it on');
    const result = { behavior: 'allow', updatedInput: FIXTURE_PROMPT.input };
    assert.deepEqual(first.store.items(first.t.id).find((i) => i.id === card.id).remote.answer, result, 'kept on the card');

    // The next start: the host still has the prompt, sends it again after hello, and gets the card’s answer.
    first.d.drop();
    first.d.connect();
    const next = rig({ store: first.store, d: first.d });
    startUp(next);
    await until(() => first.d.answers.length === 1, 'the answer, sent by the next start');
    assert.deepEqual(first.d.answers[0], { turn, id, result });
    first.d.end(turn);
    await settled(next);
    assert.deepEqual(rejections, []);
  } finally {
    process.off('unhandledRejection', onRejection);
  }
});
