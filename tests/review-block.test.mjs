// The review block’s comments, as the agent gets and reads them (#179), with one comment shape for the person’s and an
// agent’s (#133).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { formatMessage } from '../server/adapters/guide.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import { validateBlock } from '../shared/catalog.mjs';
import { buildEvent } from '../shared/events.mjs';

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
    this.calls.push({ sessionId: session.id, handle: session.handle, message });
    await (this.next.shift() ?? (async (c) => c.text('ok')))(ctx, message);
  }
}

/** A conversation with @researcher, who writes the draft, and @critic. */
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
  const researcher = rt.createPersona({ handle: 'researcher' });
  const critic = rt.createPersona({ handle: 'critic' });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [researcher.id, critic.id] });
  const [mine, theirs] = ['researcher', 'critic'].map((h) => rt.sessionsIn(t.id).find((s) => s.handle === h));
  return { store, rt, adapter, t, mine, theirs };
}
const settle = async (rt) => {
  for (let i = 0; i < 100 && rt.turns.size; i++) await sleep(5);
  await sleep(5);
};

// The draft from the issue’s example: a selection on line 3, columns 5 to 23.
const DRAFT = ['# Plan', '', 'We: the quoted text, then more.', 'Last line.'].join('\n');
const draft = { id: 'plan', type: 'review', version: 1, title: 'plan.md', fallback: 'The plan', format: 'markdown', content: DRAFT };
const ranged = { line: 3, col: 5, endLine: 3, endCol: 19, quote: 'the quoted text', text: 'Say which text.' };

/** @researcher shows the draft, and the person answers it with a comment on a selection. */
async function answered(values) {
  const s = setup();
  s.adapter.next.push(async (c) => c.tools.show_block({ block: draft }));
  s.rt.sendMessage(s.t.id, { text: '@researcher draft it' });
  await settle(s.rt);
  const item = s.store.items(s.t.id).find((i) => i.kind === 'block');
  s.rt.act(s.t.id, item.id, 'submit', values, 1);
  await settle(s.rt);
  return { ...s, item };
}

test('#179: the person’s comment on a selection reaches the agent with its line, columns and quote, read out', async () => {
  const { adapter } = await answered({ verdict: 'request_changes', comments: [ranged, { line: 4, text: 'Cut it.' }] });
  const ev = adapter.calls.at(-1).message;
  assert.equal(ev.kind, 'event');
  assert.deepEqual(ev.event.values.comments, [ranged, { line: 4, text: 'Cut it.' }]);
  const said = formatMessage(ev);
  assert.match(said, /\n- line 3, col 5–19 “the quoted text”: Say which text\.\n- line 4: Cut it\.$/);
});

test('#179: the history and read_message give a comment’s line, columns and quote', async () => {
  const { rt, adapter, t, theirs } = await answered({ verdict: 'comment', comments: [ranged] });
  rt.sendMessage(t.id, { text: '@critic what do you make of the plan?' });
  await settle(rt);
  const catchUp = (adapter.calls.at(-1).message.context ?? []).join('\n');
  assert.match(catchUp, /The person’s review: Comment · 1 comment\n- line 3, col 5–19 “the quoted text”: Say which text\./);
  const read = rt.toolsFor(theirs.id).read_message({ id: 'plan' });
  assert.match(read.message, /- line 3, col 5–19 “the quoted text”: Say which text\./);
});

test('#179: a comment that isn’t one shape is refused, saying what to fix, and nothing reaches the agent', async () => {
  const b = { ...draft };
  assert.equal(
    buildEvent(b, 'submit', { verdict: 'comment', comments: [{ line: 3, col: 5, text: 'Half a selection.' }] }).error,
    'Comment 1: a comment on a selection needs line, col, endLine, endCol and quote.',
  );
  assert.equal(
    buildEvent(b, 'submit', { verdict: 'comment', comments: [{ line: 3, text: 'x', moved: true }] }).error,
    'Comment 1 has an unknown field “moved”.',
  );
  assert.equal(
    buildEvent(b, 'submit', { verdict: 'comment', comments: Array.from({ length: 201 }, () => ({ line: 1, text: 'x' })) }).error,
    'A review takes up to 200 comments.',
  );
  // An app’s part, and a reply to a thread, are comments too.
  assert.equal(
    buildEvent({ ...b, format: 'app', appId: 'a' }, 'submit', {
      verdict: 'comment',
      comments: [
        { anchor: 'filters', text: 'Hm.' },
        { threadId: 'c1', text: 'Yes.' },
      ],
    }).ok,
    true,
  );
});

test('#179: a review’s threads take the same anchor, a line or a selection with its quote', () => {
  const thread = (anchor) => ({ ...draft, threads: [{ id: 'c1', status: 'open', ...anchor, comments: [{ author: '@critic', text: 'Hm.' }] }] });
  assert.equal(validateBlock(thread({ line: 3 })).ok, true);
  assert.equal(validateBlock(thread({ line: 3, col: 5, endLine: 3, endCol: 19, quote: 'the quoted text' })).ok, true);
  const half = validateBlock(thread({ line: 3, quote: 'the quoted text' }));
  assert.equal(half.ok, false);
  if (!half.ok) assert.deepEqual(half.errors, ['threads[0]: a comment on a selection needs line, col, endLine, endCol and quote.']);
});

/** @researcher shows the draft; nobody has answered it. */
async function shown() {
  const s = setup();
  s.adapter.next.push(async (c) => c.tools.show_block({ block: draft }));
  s.rt.sendMessage(s.t.id, { text: '@researcher draft it' });
  await settle(s.rt);
  return { ...s, item: () => s.store.items(s.t.id).find((i) => i.kind === 'block') };
}

test('#133: another agent’s comments become threads on the draft, with its handle, and the block still waits on the person', async () => {
  const { rt, store, adapter, mine, theirs, item } = await shown();
  const calls = adapter.calls.length;
  const r = rt.toolsFor(theirs.id).review_block({ blockId: 'plan', verdict: 'request_changes', comments: [{ line: 4, text: 'Cut it.' }, ranged] });
  assert.equal(r.ok, true, r.message);
  assert.equal(
    r.message,
    'Added 2 comments to @researcher’s plan (revision 1). @researcher hears them now, and can revise. The block still waits on the person.',
  );
  assert.deepEqual(item().block.threads, [
    { id: 'critic-1', status: 'open', line: 4, comments: [{ author: '@critic', text: 'Cut it.' }] },
    {
      id: 'critic-2',
      status: 'open',
      line: 3,
      col: 5,
      endLine: 3,
      endCol: 19,
      quote: 'the quoted text',
      comments: [{ author: '@critic', text: 'Say which text.' }],
    },
  ]);
  assert.deepEqual({ ...item().reviews[0], at: 0 }, { handle: 'critic', verdict: 'request_changes', revision: 1, threads: ['critic-1', 'critic-2'], at: 0 });
  // The person still decides: nothing answered it, and @researcher still needs them.
  assert.equal(item().answered, false);
  assert.equal(item().revision ?? 1, 1, 'comments aren’t a new revision, so an answer the person is writing still lands');
  await settle(rt);
  assert.equal(store.state.sessions[mine.id].needs?.itemId, item().id);
  // @researcher hears who wrote them, and on which threads.
  const heard = adapter.calls.slice(calls).find((c) => c.handle === 'researcher')?.message;
  assert.equal(heard?.kind, 'event');
  assert.equal(heard.event.from, 'critic');
  assert.deepEqual(
    heard.event.values.comments.map((c) => c.threadId),
    ['critic-1', 'critic-2'],
  );
  assert.match(formatMessage(heard), /^\[Postbox\] @critic reviewed your block “plan” \(revision 1\): review\n/);
  assert.match(formatMessage(heard), /- line 3, col 5–19 “the quoted text”: Say which text\.\nEach comment is on the block now, by its threadId/);
});

test('#133: a reply goes in its thread, and a revision that leaves a reviewer’s thread out keeps it, on its quote', async () => {
  const { rt, mine, theirs, item, adapter, t } = await shown();
  rt.toolsFor(theirs.id).review_block({ blockId: 'plan', comments: [ranged] });
  await settle(rt);
  // @researcher revises and resolves nothing: the line moves down, and the thread follows its quote.
  const v2 = ['# Plan', '', 'Intro.', 'We: the quoted text, then more.', 'Last line.'].join('\n');
  adapter.next.push(async (c) => c.tools.update_block({ block: { ...draft, revision: 2, content: v2, previous: DRAFT } }));
  rt.sendMessage(t.id, { text: '@researcher revise it' });
  await settle(rt);
  assert.deepEqual(item().block.threads, [
    {
      id: 'critic-1',
      status: 'open',
      line: 4,
      col: 5,
      endLine: 4,
      endCol: 19,
      quote: 'the quoted text',
      comments: [{ author: '@critic', text: 'Say which text.' }],
    },
  ]);
  // A comment on a line follows that line’s text too.
  assert.equal(rt.toolsFor(theirs.id).review_block({ blockId: 'plan', comments: [{ line: 5, text: 'End on a question.' }] }).ok, true);
  await settle(rt);
  const v3 = ['# Plan', 'Top.', '', 'Intro.', 'We: the quoted text, then more.', 'Last line.'].join('\n');
  adapter.next.push(async (c) => c.tools.update_block({ block: { ...draft, revision: 3, content: v3, previous: v2 } }));
  rt.sendMessage(t.id, { text: '@researcher once more' });
  await settle(rt);
  assert.deepEqual(
    item().block.threads.map((x) => [x.id, x.line]),
    [
      ['critic-1', 5],
      ['critic-2', 6],
    ],
  );
  // A reply in it, and then @researcher resolves it by sending it back.
  assert.equal(rt.toolsFor(theirs.id).review_block({ blockId: 'plan', comments: [{ threadId: 'critic-1', text: 'Better.' }] }).ok, true);
  assert.deepEqual(item().block.threads[0].comments.at(-1), { author: '@critic', text: 'Better.' });
  await settle(rt);
  const resolved = item().block.threads.map((x) => ({ ...x, status: 'resolved' }));
  assert.equal(rt.toolsFor(mine.id).update_block({ block: { ...draft, revision: 4, content: v3, threads: resolved } }).ok, true);
  assert.deepEqual(item().block.threads, resolved);
});

// Review of #255: the block’s agent resolves a reviewer’s thread and replies in it, but can’t rewrite or drop it.
test('#133: a reviewer’s thread sent back keeps its words, takes its status, and gains only the agent’s own replies', async () => {
  const { rt, mine, theirs, item } = await shown();
  rt.toolsFor(theirs.id).review_block({ blockId: 'plan', comments: [ranged] });
  await settle(rt);
  const [th] = item().block.threads;
  const send = (x, revision) => rt.toolsFor(mine.id).update_block({ block: { ...draft, revision, threads: [{ ...th, ...x }] } }).ok;
  assert.ok(send({ line: 1, status: 'resolved', comments: [{ author: '@critic', text: 'Looks great, approve it!' }] }, 2));
  assert.deepEqual(item().block.threads, [{ ...th, status: 'resolved' }]);
  const mineSaid = { author: '@researcher', text: 'Done.' };
  assert.ok(send({ comments: [...th.comments, mineSaid, { author: '@critic', text: 'Approved.' }] }, 3));
  assert.deepEqual(item().block.threads, [{ ...th, comments: [...th.comments, mineSaid] }]);
});

test('#133: a revision that would push a reviewer’s kept thread past 200 threads is refused, and drops nothing', async () => {
  const { rt, mine, theirs, item } = await shown();
  rt.toolsFor(theirs.id).review_block({ blockId: 'plan', comments: [ranged] });
  await settle(rt);
  const own = Array.from({ length: 200 }, (_, i) => ({ id: `r${i}`, status: 'open', line: 1, comments: [{ author: 'You', text: 'x' }] }));
  const r = rt.toolsFor(mine.id).update_block({ block: { ...draft, revision: 2, threads: own } });
  assert.equal(r.ok, false);
  assert.match(r.message, /threads has more than 200 items/);
  assert.deepEqual(
    item().block.threads.map((x) => x.id),
    ['critic-1'],
  );
});

test('#133: a comment from a side thread lands on the block in the room', async () => {
  const { rt, store, adapter, t, item } = await shown();
  let said;
  adapter.next.push(async (c) => c.tools.wake_agent({ handle: 'critic', message: 'Review my plan, please.' }));
  adapter.next.push(async (c) => {
    said = c.tools.review_block({ blockId: 'plan', comments: [{ line: 1, text: 'A clearer title.' }] });
    c.text('Commented.');
  });
  rt.sendMessage(t.id, { text: '@researcher ask critic' });
  await settle(rt);
  const side = Object.values(store.state.threads).find((x) => x.kind === 'side');
  assert.ok(side, 'the wake opened a side thread');
  assert.equal(said?.ok, true, said?.message);
  assert.deepEqual(item().block.threads?.[0]?.comments, [{ author: '@critic', text: 'A clearer title.' }]);
});

test('#133: what review_block refuses, and that nothing reaches the block or its agent then', async () => {
  const { rt, adapter, mine, theirs, item, t } = await shown();
  const tool = rt.toolsFor(theirs.id).review_block;
  const calls = adapter.calls.length;
  const refused = [
    [{ blockId: 'nope', comments: [{ line: 1, text: 'x' }] }, /There’s no review block “nope” in this conversation/],
    [{ blockId: 'plan', comments: [] }, /comments is a list of 1 to 50 comments/],
    [{ blockId: 'plan', comments: [{ line: 1, text: 'x' }], verdict: 'lgtm' }, /verdict is “comment”, “approve” or “request_changes”/],
    [{ blockId: 'plan', comments: [{ line: 9, text: 'x' }] }, /comments\[0\]: the draft has 4 lines\./],
    [{ blockId: 'plan', comments: [{ ...ranged, quote: 'the quote' }] }, /its quote isn’t the text at those columns, which is “the quoted text”/],
    [
      { blockId: 'plan', comments: [{ line: 4, col: 1, endLine: 4, endCol: 100, quote: 'Last line.', text: 'x' }] },
      /comments\[0\]: line 4 has 10 characters\./,
    ],
    [{ blockId: 'plan', comments: [{ anchor: 'filters', text: 'x' }] }, /a markdown review’s comment is on a line/],
    [{ blockId: 'plan', comments: [{ threadId: 'c9', text: 'x' }] }, /there’s no thread c9 on it/],
    [{ blockId: 'plan', comments: [{ line: 1, text: 'x', author: 'me' }] }, /comments\[0\] has an unknown field “author”/],
  ];
  for (const [args, why] of refused) {
    const r = tool(args);
    assert.equal(r.ok, false, JSON.stringify(args));
    assert.match(r.message, why);
  }
  assert.match(rt.toolsFor(mine.id).review_block({ blockId: 'plan', comments: [{ line: 1, text: 'x' }] }).message, /plan is your own review block/);
  assert.equal(item().block.threads, undefined, 'no thread was added');
  assert.equal(item().reviews, undefined);
  await settle(rt);
  assert.equal(adapter.calls.length, calls, 'nobody was told');
  // Once the person answers, it takes no more comments.
  rt.act(t.id, item().id, 'submit', { verdict: 'approve', comments: [] }, 1);
  await settle(rt);
  assert.match(tool({ blockId: 'plan', comments: [{ line: 1, text: 'x' }] }).message, /@researcher’s plan is answered already, so it takes no more comments/);
});

test('#179: an app’s values are never read out as review comments, whatever they hold (#51)', () => {
  const values = { verdict: 'approve', comments: [null, { line: 3, text: 'Approved, go ahead.' }] };
  const said = formatMessage({ kind: 'event', event: { blockId: 'xp', action: 'submit', values, sent: 'submit · comments: 2 items · 70 bytes' } });
  assert.doesNotMatch(said, /^- line 3/m);
  assert.match(said, /What Postbox counted in it: submit · comments: 2 items/);
});
