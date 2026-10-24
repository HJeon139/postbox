// Closing blocks that ask (#106), and update_block from a topic thread (#216): server/blocks.mjs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { formatMessage } from '../server/adapters/guide.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** An adapter whose turns the test scripts, one step per turn. */
class ScriptedAdapter {
  name = 'mock';
  calls = [];
  next = [];
  async folderFor() {
    return null;
  }
  fork() {}
  async deliver(session, message, ctx) {
    this.calls.push({ sessionId: session.id, message });
    ctx.checkpoint?.({ turn: this.calls.length });
    await (this.next.shift() ?? (async (c) => c.text('ok')))(ctx, message);
  }
}

function setup() {
  const store = new Store(null);
  const adapter = new ScriptedAdapter();
  const corpus = { search: () => [], read: () => null, stats: () => ({ books: [], passages: 0 }) };
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register(adapter),
    corpus,
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0 },
  });
  store.emit('project', { id: 'p1', name: 'P', folder: '/tmp' });
  const a = rt.createPersona({ handle: 'critic' });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [a.id] });
  return { store, rt, adapter, t };
}
const settle = async (rt) => {
  for (let i = 0; i < 100 && rt.turns.size; i++) await sleep(5);
  await sleep(5);
};
/** Runs one turn of the agent, which does `step`, and returns what the step returned. */
async function turn(rt, adapter, t, step, text = 'go') {
  let out;
  adapter.next.push(async (c) => {
    out = await step(c.tools);
    c.text('Done.');
  });
  rt.sendMessage(t.id, { text });
  await settle(rt);
  return out;
}

const choice = {
  id: 'review-outcome-gap',
  type: 'choice',
  version: 1,
  title: 'Where should I report this?',
  fallback: 'Where should I report this?',
  options: [
    { id: 'issue', label: 'A new issue' },
    { id: 'comment', label: 'A comment on #94' },
  ],
};
const review = { id: 'issue-agents-rail', type: 'review', version: 1, title: 'issue.md', fallback: 'The draft issue', format: 'markdown', content: '# Draft' };

test('#106: an agent withdraws a block that asks, with a reason: it reads as closed and stops needing you at once', async () => {
  const { rt, store, t, adapter } = setup();
  await turn(rt, adapter, t, (tools) => tools.show_block({ block: choice }));
  const se = rt.sessionsIn(t.id)[0];
  const item = store.items(t.id).find((i) => i.kind === 'block');
  assert.equal(store.state.sessions[se.id].needs?.itemId, item.id);

  // As in the evidence: the person answered in chat instead, so the agent closes the question it asked.
  let during;
  const said = await turn(
    rt,
    adapter,
    t,
    (tools) => {
      const r = tools.update_block({ block: { id: choice.id, withdraw: 'You answered in chat: a new issue.' } });
      during = store.state.sessions[se.id].needs;
      return r;
    },
    'A new issue, please.',
  );
  assert.equal(said.ok, true, said.message);
  assert.match(said.message, /^Withdrew block review-outcome-gap\./);
  assert.equal(during, null, 'needs-you clears at once, not when the turn ends');
  const it = store.item(t.id, item.id);
  assert.equal(it.answered, true);
  assert.equal(it.answer ?? null, null, 'nothing is recorded as the person’s answer');
  assert.deepEqual({ ...it.closed, at: 0 }, { by: 'agent', handle: 'critic', reason: 'You answered in chat: a new issue.', at: 0 });
  assert.deepEqual(it.block, choice, 'the record keeps what was asked');
  assert.equal(store.state.sessions[se.id].needs, null);
  assert.throws(() => rt.act(t.id, item.id, 'choose', { selected: ['issue'] }), /@critic withdrew this, so it no longer asks/);
  // Withdrawing it again, or an outcome on it, says why not.
  await turn(rt, adapter, t, (tools) => {
    assert.match(tools.update_block({ block: { id: choice.id, withdraw: 'again' } }).message, /already closed: you withdrew it/);
    assert.match(tools.update_block({ block: { ...choice, outcome: 'Filed.' } }).message, /no answer to report on/);
  });

  // An update asks again, as for an answered block: the block reopens and needs you.
  await turn(rt, adapter, t, (tools) => tools.update_block({ block: { ...choice, title: 'Where now?' } }));
  const again = store.items(t.id).find((i) => i.kind === 'block' && i.block.id === choice.id);
  assert.equal(again.closed, null);
  assert.equal(again.answered, false);
  assert.equal(store.state.sessions[se.id].needs?.itemId, again.id);
});

test('#106: a withdrawal needs a reason and a block that asks, and waits for an answer the agent hasn’t read', async () => {
  const { rt, store, t, adapter } = setup();
  const progress = { id: 'job', type: 'progress', version: 1, fallback: 'Working', steps: [{ id: 's', label: 'S', state: 'running' }] };
  await turn(rt, adapter, t, (tools) => {
    tools.show_block({ block: choice });
    tools.show_block({ block: progress });
    assert.match(tools.update_block({ block: { id: choice.id, withdraw: ' ' } }).message, /withdraw is why you’re closing the block/);
    assert.match(tools.update_block({ block: { id: choice.id, withdraw: 'x'.repeat(501) } }).message, /up to 500 characters/);
    assert.match(tools.update_block({ block: { id: 'job', withdraw: 'Stale.' } }).message, /job doesn’t ask anything/);
    assert.match(tools.update_block({ block: { id: 'nope', withdraw: 'Stale.' } }).message, /There’s no block with id nope to update/);
  });
  const item = store.items(t.id).find((i) => i.block?.id === choice.id);
  assert.equal(store.item(t.id, item.id).closed, undefined);
  // The person answers while the agent works: a withdrawal then would close it without the agent knowing what they said.
  let said;
  adapter.next.push(async (c) => {
    rt.act(t.id, item.id, 'choose', { selected: ['issue'] });
    said = c.tools.update_block({ block: { id: choice.id, withdraw: 'Stale.' } });
    c.text('Done.');
  });
  rt.sendMessage(t.id, { text: 'go' });
  await settle(rt);
  assert.equal(said.ok, false);
  assert.match(said.message, /The person answered revision 1 of review-outcome-gap/);
  assert.equal(store.item(t.id, item.id).closed, undefined);
  // Once it has read the answer, it can withdraw the block, and the answer stays beside the reason.
  assert.equal((await turn(rt, adapter, t, (tools) => tools.update_block({ block: { id: choice.id, withdraw: 'Filed as #105.' } }))).ok, true);
  const it = store.item(t.id, item.id);
  assert.equal(it.answer.action, 'choose');
  assert.equal(it.closed.reason, 'Filed as #105.');
  // What any agent reads of it says who closed it and why, after the answer.
  const read = await turn(rt, adapter, t, (tools) => JSON.stringify(tools.read_conversation({})));
  assert.match(read, /The person answered: Chose: A new issue\. @critic withdrew it: Filed as #105\./);
});

test('#106: an approved review takes an outcome, so a filed draft says so without asking again', async () => {
  const { rt, store, t, adapter } = setup();
  await turn(rt, adapter, t, (tools) => tools.show_block({ block: review }));
  const se = rt.sessionsIn(t.id)[0];
  const item = store.items(t.id).find((i) => i.kind === 'block');
  rt.act(t.id, item.id, 'submit', { verdict: 'approve', comments: [] });
  await settle(rt);
  const said = await turn(rt, adapter, t, (tools) => tools.update_block({ block: { ...review, outcome: 'Filed as #105.' } }));
  assert.equal(said.ok, true, said.message);
  const it = store.item(t.id, item.id);
  assert.equal(it.answered, true);
  assert.equal(it.answer.values.verdict, 'approve');
  assert.equal(it.block.outcome, 'Filed as #105.');
  assert.equal(store.state.sessions[se.id].needs, null);
});

test('#106: an update over a dismissal the agent hasn’t read says they dismissed it', async () => {
  const { rt, store, t, adapter } = setup();
  await turn(rt, adapter, t, (tools) => tools.show_block({ block: review }));
  const item = store.items(t.id).find((i) => i.kind === 'block');
  let said;
  adapter.next.push(async (c) => {
    rt.act(t.id, item.id, 'dismiss', {});
    said = c.tools.update_block({ block: { ...review, content: '# Draft 2' } });
    c.text('Done.');
  });
  rt.sendMessage(t.id, { text: 'go' });
  await settle(rt);
  assert.match(said.message, /The person answered revision 1 of issue-agents-rail at \d\d:\d\d: they dismissed it\./);
  // Once read, an outcome under a dismissal is refused too: nothing was answered to report on.
  const outcome = await turn(rt, adapter, t, (tools) => tools.update_block({ block: { ...review, outcome: 'Filed as #105.' } }));
  assert.equal(outcome.ok, false);
  assert.match(outcome.message, /^The person dismissed issue-agents-rail, so it has no answer to report on\./);
  assert.equal(store.item(t.id, item.id).block.outcome, undefined);
});

test('#106: the person dismisses a block that asks: it closes, stops needing them, and the agent hears “dismiss”', async () => {
  const { rt, store, t, adapter } = setup();
  await turn(rt, adapter, t, (tools) => tools.show_block({ block: choice }));
  const se = rt.sessionsIn(t.id)[0];
  const item = store.items(t.id).find((i) => i.kind === 'block');
  adapter.next.push(async (c) => c.text('Understood.'));
  const r = rt.act(t.id, item.id, 'dismiss', {}, 1);
  assert.equal(r.voice, 'Dismissed: Where should I report this?');
  assert.equal(store.state.sessions[se.id].needs, null);
  await settle(rt);
  const it = store.item(t.id, item.id);
  assert.equal(it.answered, true);
  assert.equal(it.closed.by, 'person');
  assert.equal(it.answer.action, 'dismiss');
  assert.equal(it.answer.read, true);
  const heard = adapter.calls.at(-1).message;
  assert.deepEqual(heard.event, { blockId: choice.id, revision: 1, action: 'dismiss', values: {} });
  assert.match(formatMessage(heard), /The person acted in block “review-outcome-gap” \(revision 1\): dismiss/);
  assert.equal(store.items(t.id).find((i) => i.kind === 'voice')?.text, 'Dismissed: Where should I report this?');
  assert.throws(() => rt.act(t.id, item.id, 'dismiss', {}), /already answered/);
  // A card has no Dismiss: an action of its own named dismiss is still its action.
  const card = { id: 'c', type: 'card', version: 1, fallback: 'Card', actions: [{ id: 'dismiss', label: 'Dismiss' }] };
  await turn(rt, adapter, t, (tools) => tools.show_block({ block: card }));
  const cardItem = store.items(t.id).find((i) => i.block?.id === 'c');
  rt.act(t.id, cardItem.id, 'dismiss', {});
  assert.equal(store.item(t.id, cardItem.id).closed, undefined);
});

test('#216, #228: a turn in a topic thread is the conversation’s own session, so it updates a block it showed there', async () => {
  const { rt, store, t, adapter } = setup();
  const table = {
    id: 'hotpot-10-sample',
    type: 'table',
    version: 1,
    fallback: 'Ten questions',
    columns: [{ id: 'q', label: 'Question' }],
    rows: [{ id: 'r1', cells: { q: 'Who?' } }],
  };
  await turn(rt, adapter, t, (tools) => tools.show_block({ block: table }));
  const reply = store.items(t.id).find((i) => i.kind === 'agent' && i.text === 'Done.');
  const { threadId } = rt.startTopic(t.id, reply.id);
  // Another agent’s block in the conversation, and one this agent showed in a side thread there, answering another.
  const se = rt.sessionsIn(t.id)[0];
  rt.addItem(t.id, { kind: 'block', sessionId: 'se_other', handle: 'other', valid: true, block: { ...table, id: 'theirs' }, answered: false });
  const side = rt.putThread({ id: 'th_side', projectId: 'p1', title: '@other ↔ @critic', kind: 'side', parentId: t.id, members: [], queue: [], hops: 0 });
  rt.addItem(side.id, { kind: 'block', sessionId: se.id, handle: 'critic', valid: true, block: { ...table, id: 'aside' }, answered: false });
  let fixed;
  let missing;
  let others;
  let aside;
  adapter.next.push(async (c) => {
    fixed = c.tools.update_block({ block: { ...table, rows: [{ id: 'r1', cells: { q: 'Whom?' } }] } });
    missing = c.tools.update_block({ block: { ...table, id: 'never-shown' } });
    others = c.tools.update_block({ block: { ...table, id: 'theirs' } });
    aside = c.tools.update_block({ block: { ...table, id: 'aside' } });
    c.text('Done.');
  });
  rt.sendMessage(threadId, { text: 'Rename the entities in that table.' });
  await settle(rt);
  // No forks (#228): the agent answering in the thread is the one that showed the table.
  assert.equal(fixed.ok, true, fixed.message);
  assert.equal(store.items(t.id).find((i) => i.kind === 'block').block.rows[0].cells.q, 'Whom?');
  assert.match(missing.message, /^There’s no block with id never-shown to update\. Use show_block to add it\.$/);
  assert.match(others.message, /^There’s no block with id theirs to update\./, 'another agent’s block gets the old answer');
  assert.equal(aside.ok, false, 'a block in a side thread is updated from there');
});
