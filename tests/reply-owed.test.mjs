// #634: an agent’s ask that its answer never reached. Since #1518 a reply that @-mentions no one goes back to the
// agents whose mentions woke its turn, so the common case reaches the asker. These are the cases left: the woken turn
// also took the person’s message, its reply @-mentioned only another agent, or it failed. The ask then reads
// “No reply from @beta.” under it (`noReplyFrom`), until a later reply of beta’s reaches alpha.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as arrange from './arrange.mjs';
import { held, settle, setup } from './side-threads-fixture.mjs';

/** A room of alpha, beta and gamma; alpha’s turn asks beta, and beta’s turn does what `answer` says. */
async function asked(answer, { alsoPerson = false } = {}) {
  const f = setup();
  const t = f.rt.createThread({ projectId: 'p1', title: 'Ask', personaIds: [f.a.id, f.b.id, f.c.id] });
  const [alpha, beta] = arrange.sessionsIn(f.rt, t.id);
  const items = () => f.store.items(t.id);
  const ask = () => items().find((i) => i.kind === 'agent' && i.sessionId === alpha.id && /@beta/.test(i.text));
  // beta is busy when the ask comes, so a message of the person’s can wait beside it and go in the same turn.
  const busy = held();
  f.adapter.next.push(busy.step);
  f.rt.sendMessage(t.id, { text: '@beta warm up' });
  await new Promise((r) => setTimeout(r, 10));
  f.adapter.next.push(async (c) => c.text('@beta please check the relay and tell me if it holds.'));
  f.rt.sendMessage(t.id, { text: '@alpha ask beta to check the relay' });
  for (let i = 0; i < 100 && !ask(); i++) await new Promise((r) => setTimeout(r, 5));
  if (alsoPerson) f.rt.sendMessage(t.id, { text: '@beta and the docs, please' });
  f.adapter.next.push((/** @type {any} */ c) => answer(c, { ask }));
  busy.release();
  await settle(f.rt);
  return { ...f, t, alpha, beta, ask, items, se: () => f.store.state.sessions[beta.id] };
}

test('#634 a reply that goes back to the asker leaves no mark: #1518 already answers the common case', async () => {
  const f = await asked(async (c) => c.text('It holds.'));
  assert.equal(f.ask().noReplyFrom ?? null, null);
});

test('#634 a reply that came back isn’t an ask: alpha may end that exchange without answering beta', async () => {
  const f = setup();
  f.adapter.next.push(async (c) => c.text('@beta please check the relay.'));
  f.adapter.next.push(async (c) => c.text('It holds.'));
  // alpha takes beta’s reply that came back, and answers someone else.
  f.adapter.next.push(async (c) => c.text('@gamma noted, over to you.'));
  f.rt.sendMessage(f.t.id, { text: '@alpha ask beta to check the relay' });
  await settle(f.rt);
  const back = f.store.items(f.t.id).find((i) => i.kind === 'agent' && i.sessionId === f.beta.id && i.wentBack?.includes('alpha'));
  assert.ok(back, 'beta’s reply went back to alpha');
  assert.equal(back.noReplyFrom ?? null, null);
});

test('#634 an ask taken with the person’s message, answered to the person only, reads “no reply from @beta”', async () => {
  const f = await asked(async (c) => c.text('The docs are fine.'), { alsoPerson: true });
  assert.deepEqual(f.ask().noReplyFrom, ['beta']);
  assert.deepEqual(
    f.se().owes.map((o) => o.from),
    ['alpha'],
  );
});

test('#634 a reply that @-mentions only another agent leaves alpha’s ask marked', async () => {
  const f = await asked(async (c) => c.text('@gamma can you check the relay?'));
  assert.deepEqual(f.ask().noReplyFrom, ['beta']);
});

test('#634 a failed turn leaves the ask marked; one whose failed reply @-mentions alpha doesn’t', async () => {
  const f = await asked(async () => {
    throw new Error('boom');
  });
  assert.deepEqual(f.ask().noReplyFrom, ['beta']);
  const g = await asked(async (c) => {
    c.text('@alpha I couldn’t reach the relay.');
    throw new Error('boom');
  });
  assert.equal(g.ask().noReplyFrom ?? null, null, 'its failed reply still reached alpha');
});

test('#634 the person’s own ask of beta isn’t marked: they see every reply in the room', async () => {
  const f = await asked(async (c) => c.text('@gamma over to you.'));
  const mine = f.items().find((i) => i.kind === 'user' && /warm up/.test(i.text));
  assert.equal(mine.noReplyFrom ?? null, null);
});

test('#634 a later reply of beta’s that reaches alpha clears the mark', async () => {
  const f = await asked(async (c) => c.text('@gamma can you check the relay?'));
  assert.deepEqual(f.ask().noReplyFrom, ['beta']);
  f.adapter.next.push(async (c) => c.text('@alpha the relay holds.'));
  f.rt.sendMessage(f.t.id, { text: '@beta report back' });
  await settle(f.rt);
  assert.equal(f.ask().noReplyFrom ?? null, null);
  assert.equal(f.se().owes ?? null, null);
});

test('#634 beta’s reaction to the ask answers it: a “noted” in a click', async () => {
  const f = await asked(async (c, { ask }) => {
    await c.tools.react({ id: ask().id, emoji: '👍' });
    c.text('@gamma over to you.');
  });
  assert.equal(f.ask().noReplyFrom ?? null, null);
});

test('#634 beta answering in a topic it opens for alpha reaches alpha: no mark', async () => {
  const f = await asked(
    async (c, { ask }) => {
      await c.tools.open_topic({ itemId: ask().id, message: '@alpha it holds, details here.' });
      c.text('Answered in the topic.');
    },
    { alsoPerson: true },
  );
  assert.equal(f.ask().noReplyFrom ?? null, null);
});

test('#634 beta answering by review comments on alpha’s block reaches alpha: no mark', async () => {
  const f = setup();
  const block = { id: 'plan', type: 'review', version: 1, title: 'plan.md', fallback: 'The plan', format: 'markdown', content: '# Plan\n\nShip it.' };
  f.adapter.next.push(async (c) => {
    c.tools.show_block({ block });
    c.text('@beta please review the plan.');
  });
  f.adapter.next.push(async (c) => {
    await c.tools.review_block({ blockId: 'plan', comments: [{ line: 3, text: 'When?' }] });
    c.text('Reviewed.');
  });
  f.adapter.next.push(async (c) => c.text('Thanks, noted.'));
  f.rt.sendMessage(f.t.id, { text: '@alpha write the plan' });
  await settle(f.rt);
  await settle(f.rt);
  const ask = f.store.items(f.t.id).find((i) => i.kind === 'agent' && /@beta please review/.test(i.text ?? ''));
  assert.ok(ask);
  assert.equal(ask.noReplyFrom ?? null, null);
});
