// The answers update_block’s refusal leaves to come at the turn’s end, as before #1810 (server/block-unread.mjs,
// unreadAnswer): one whose agent works on a host, which never reads the refusal in its call, and a confirm’s, whose turn
// lets the command it shows run without a card.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { onTool } from '../server/remote/turns-tools.mjs';
import { requestOf } from '../server/write-intent.mjs';
import { answeredMidTurn, answersGiven, COMMENTS } from './block-answer-midturn-fixture.mjs';

/**
 * update_block from a host, as server/remote/turns.mjs applies it, from inside the agent’s turn, which runs on the host
 * while the call is applied (turn.remote). The call is queued there (shared/remote-protocol-constants.mjs, TOOL_ROUTES):
 * the shim told the agent “sent”, and the daemon only logs this reply. Gives the reply.
 */
async function fromHost(block, { rt, se }) {
  const replies = [];
  const live = rt.turns.get(se.id);
  const rts = {
    rt,
    byTurn: new Map([['t_host', { sessionId: se.id, rt: live }]]),
    needed: new Map([['host_1', { link: { send: (m) => replies.push(m) } }]]),
    applying: new Set(),
    restoring: new Map(),
    now: () => 1000,
  };
  live.remote = { hostId: 'host_1' };
  try {
    await onTool(/** @type {any} */ (rts), 'host_1', { turn: 't_host', id: `c_${replies.length}_${Date.now()}`, name: 'update_block', args: { block } });
  } finally {
    delete live.remote;
  }
  return replies[0];
}

test('#1810 on a host, the answer isn’t settled by a refusal its agent never reads: it comes whole when the turn ends', async () => {
  const states = [];
  const f = await answeredMidTurn({
    update: async (_c, block, g) => {
      const r = await fromHost(block, g);
      states.push({ entry: g.rt.delivery.inbox(g.se.id).find((e) => e.itemId === g.item.id)?.state, read: g.store.item(g.t.id, g.item.id).answer.read });
      return r;
    },
  });
  assert.equal(f.replies[0].ok, false);
  assert.match(f.replies[0].text, /It reaches you when this turn ends: read it, then update\.$/);
  assert.deepEqual(states[0], { entry: 'waiting', read: false }, 'its entry still waits, unread');
  // One turn follows, given the whole answer.
  const given = answersGiven(f.adapter, f.item.id);
  assert.equal(given.length, 1);
  assert.deepEqual(
    given[0].event.values.comments.map((x) => x.text),
    COMMENTS.map((x) => x.text),
  );
  assert.equal(f.adapter.calls.length, f.calls + 1);
});

const confirm = {
  id: 'run-tests',
  type: 'confirm',
  version: 1,
  fallback: 'Run the tests?',
  statement: 'Run `npm test` in the project folder?',
  confirmLabel: 'Run them',
};

test('#1810 a confirm’s answer isn’t settled by the refusal: it starts its turn, which began with the person confirming', async () => {
  /** @type {any} */
  let request;
  const read = [];
  const f = await answeredMidTurn({
    block: confirm,
    revised: { ...confirm, statement: 'Run `npm test` again?' },
    act: ['confirm', {}],
    update: (c, block, g) => {
      const r = c.tools.update_block({ block });
      read.push(g.store.item(g.t.id, g.item.id).answer.read);
      return r;
    },
    // The turn that follows: what write-intent.mjs reads as the person’s request.
    during: ({ rt, se, adapter }) =>
      adapter.next.push(async (c) => {
        request = requestOf(rt, rt.turns.get(se.id));
        c.text('ok');
      }),
  });
  assert.equal(f.replies[0].ok, false);
  assert.match(f.replies[0].message, /It reaches you when this turn ends: read it, then update\.$/);
  assert.deepEqual(read, [false, false], 'unread until its turn starts');
  assert.equal(answersGiven(f.adapter, f.item.id).length, 1);
  assert.deepEqual(request?.confirmed, [{ label: 'Run them', statement: confirm.statement }]);
});
