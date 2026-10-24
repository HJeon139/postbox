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
