// A requested call that awaits external work while the store closes (the integrator’s re-review of #598, should fix 3;
// rule 14’s sweep of callbacks that await and then write). settledCall awaits the judge and then Postbox’s own git push:
// a store that closes during the push must not make the call throw on the stopped turn, write a line into memory only,
// or let the agent’s own push run; the push that already happened is named in the log. A store that closes during the
// judge call makes no push at all.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { settledCall } from '../server/write-intent.mjs';
import { allow, bash, lines, setup, sleep, until } from './requested-setup.mjs';

const eio = () => Object.assign(new Error('disk sync refused'), { code: 'EIO' });
const URL = 'https://github.com/HJeon139/postbox.git';

/** Postbox’s push, held until the spec releases it; `during` runs while it is held. */
function heldPushes(s, during) {
  const seen = { made: 0 };
  s.rt.pushes = {
    consequence: async (o) => ({ branch: 'feat/now', current: 'feat/now', sha: 'a'.repeat(40), objects: '/x', url: o.url, sentence: 'commit aaaaaaa lands' }),
    run: async () => {
      seen.made++;
      await during();
      return { ok: true };
    },
  };
  s.store.emit('project', { ...s.store.state.projects.p1, pushUrl: URL });
  return seen;
}

/** A turn that asks for one push and holds open, so settledCall runs inside it; returns its session and the call. */
async function turnAsking(s, text) {
  let release = () => {};
  const held = new Promise((r) => {
    release = () => r(undefined);
  });
  s.next.push(async () => held);
  s.rt.sendMessage(s.t.id, { text });
  await until(() => s.rt.turns.size === 1);
  const sessionId = [...s.rt.turns.keys()][0];
  return { sessionId, release };
}

test('the store closes during Postbox’s push: no throw, nothing written, the agent’s own push refused, and the push named in the log', async (t) => {
  const s = await setup({ judged: () => allow('push it to origin') });
  const logged = [];
  t.mock.method(console, 'error', (...a) => logged.push(a.join(' ')));
  const seen = heldPushes(s, async () => s.store.fail(eio()));
  const { sessionId, release } = await turnAsking(s, 'Push it to origin.');
  const answer = await settledCall(s.rt, sessionId, bash('git push -u origin feat/now'));
  assert.equal(seen.made, 1, 'the push was already under way when the store closed');
  assert.equal(answer?.allow, false, 'the agent’s own push does not run');
  assert.equal(lines(s).length, 0, 'no line written into a closed store');
  assert.ok(
    logged.some((l) => /feat\/now/.test(l) && /a{7}/.test(l)),
    `the push is named in the log: ${logged.join(' | ')}`,
  );
  release();
  await sleep(20);
});

test('the store closes during the judge call: Postbox makes no push', async () => {
  let close = () => {};
  const s = await setup({
    judged: async () => {
      close();
      return allow('push it to origin');
    },
  });
  const seen = heldPushes(s, async () => {});
  const { sessionId, release } = await turnAsking(s, 'Push it to origin.');
  close = () => s.store.fail(eio());
  const answer = await settledCall(s.rt, sessionId, bash('git push -u origin feat/now'));
  assert.equal(seen.made, 0, 'no push for a turn the outage stopped');
  assert.notEqual(answer?.allow, true);
  release();
  await sleep(20);
});
