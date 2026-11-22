// #1208: who a review’s comments are by, as agents send them back. An agent revising its review echoes the person’s
// comments by the name it read them under: “The person” (read_message, #791) or “You” (when the issue was filed). The
// echo was refused with the whole update, which wasted the agent’s turn. A review stored before #1143’s rule refused every review_block on it. And #1177 said the author
// rule kept an agent from showing a review in another agent’s name, which show_block allowed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import * as arrange from './arrange.mjs';

const DRAFT = ['# Plan', '', 'We: the quoted text, then more.', 'Last line.'].join('\n');
const draft = { id: 'plan', type: 'review', version: 1, title: 'plan.md', fallback: 'The plan', format: 'markdown', content: DRAFT };

/** A conversation with @researcher, who writes the draft, and @critic, who reviews it; the draft is shown. */
function shown() {
  const store = new Store(null);
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register({ name: 'mock', async folderFor() {}, fork() {}, async deliver() {} }),
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0 },
  });
  store.emit('project', { id: 'p1', name: 'P', folder: '/tmp' });
  const t = rt.createThread({
    projectId: 'p1',
    title: 'T',
    personaIds: [rt.createPersona({ handle: 'researcher' }).id, rt.createPersona({ handle: 'critic' }).id],
  });
  const [mine, theirs] = ['researcher', 'critic'].map((h) => arrange.agentIn(rt, t.id, h));
  assert.equal(rt.toolsFor(mine.id).show_block({ block: draft }).ok, true);
  const item = () => store.items(t.id).find((i) => i.kind === 'block' && i.block.id === 'plan');
  return { rt, t, item, author: rt.toolsFor(mine.id), reviewer: rt.toolsFor(theirs.id) };
}

test('#1208 an agent that echoes the person’s comment as by “You” has its update applied, and the comment stays the person’s', () => {
  const s = shown();
  s.rt.act(s.t.id, s.item().id, 'submit', { verdict: 'request_changes', comments: [{ line: 3, text: 'Shorter.' }] }, 1);
  // The agent has read the answer, as it does in the turn the answer starts.
  arrange.setItem(s.rt, s.t.id, s.item().id, { answer: { ...s.item().answer, read: true } });
  const thread = s.item().block.threads[0];
  const echoed = {
    ...thread,
    status: 'resolved',
    comments: [
      { author: 'You', text: 'Shorter.' },
      { author: '@researcher', text: 'Cut to one line.' },
    ],
  };
  const r = s.author.update_block({ block: { ...draft, content: DRAFT.replace(', then more', ''), threads: [echoed] } });
  assert.equal(r.ok, true, r.message);
  const after = s.item().block.threads.find((t) => t.id === thread.id);
  assert.deepEqual(
    after.comments.map((c) => [c.author, c.text]),
    [
      ['you', 'Shorter.'],
      ['@researcher', 'Cut to one line.'],
    ],
    'the person’s words stay theirs, and the reply is added',
  );
  assert.equal(after.status, 'resolved');
});

test('#1208 an echoed comment in a name that’s no one’s is dropped, the rest of the update applied, and the agent told', () => {
  const s = shown();
  const own = { id: 'r1', status: 'open', line: 4, comments: [{ author: '@researcher', text: 'Check the end.' }] };
  assert.equal(s.author.update_block({ block: { ...draft, threads: [own] } }).ok, true);
  const odd = { ...own, comments: [...own.comments, { author: 'The person', text: 'Looks fine.' }, { author: '@researcher', text: 'Checked.' }] };
  const r = s.author.update_block({ block: { ...draft, threads: [odd] } });
  assert.equal(r.ok, true, r.message);
  assert.match(r.message, /1 comment in another name wasn’t added/, 'the agent hears what was left out');
  assert.deepEqual(
    s.item().block.threads[0].comments.map((c) => c.text),
    ['Check the end.', 'Checked.'],
  );
});

test('#1208 a review stored before the author rule still takes another agent’s review_block', () => {
  const s = shown();
  const threads = [{ id: 'c1', status: 'open', line: 4, comments: [{ author: 'You', text: 'Cut it.' }] }];
  arrange.setItem(s.rt, s.t.id, s.item().id, { block: { ...s.item().block, threads } });
  const r = s.reviewer.review_block({ blockId: 'plan', comments: [{ line: 3, text: 'Say which text.' }] });
  assert.equal(r.ok, true, r.message);
  assert.deepEqual(
    s.item().block.threads.map((t) => t.comments.map((c) => c.author)),
    [['@researcher'], ['@critic']],
    'the old “You” reads as its agent’s, and the review lands',
  );
});

test('#1208 show_block refuses a review with a comment in another agent’s name, as #1177 said the rule does', () => {
  const s = shown();
  const theirs = [{ id: 'x1', status: 'open', line: 3, comments: [{ author: '@critic', text: 'Approved by me.' }] }];
  const r = s.author.show_block({ block: { ...draft, id: 'plan-2', threads: theirs } });
  assert.equal(r.ok, false);
  assert.match(r.message, /@critic/);
  assert.equal(
    s.author.show_block({ block: { ...draft, id: 'plan-3', threads: [{ ...theirs[0], comments: [{ author: '@researcher', text: 'Mine.' }] }] } }).ok,
    true,
  );
});

for (const label of ['The person', 'You'])
  test(`#1208 an agent that resolves the person’s thread, echoing their comment as by “${label}”, has the thread resolved`, () => {
    const s = shown();
    s.rt.act(s.t.id, s.item().id, 'submit', { verdict: 'request_changes', comments: [{ line: 3, text: 'Shorter.' }] }, 1);
    arrange.setItem(s.rt, s.t.id, s.item().id, { answer: { ...s.item().answer, read: true } });
    const thread = s.item().block.threads[0];
    const echoed = { ...thread, status: 'resolved', comments: [{ author: label, text: 'Shorter.' }] };
    const r = s.author.update_block({ block: { ...draft, content: DRAFT.replace(', then more', ''), threads: [echoed] } });
    assert.equal(r.ok, true, r.message);
    const after = s.item().block.threads.find((t) => t.id === thread.id);
    assert.deepEqual([after.status, after.comments.map((c) => [c.author, c.text])], ['resolved', [['you', 'Shorter.']]]);
  });

test('#1208 its own thread echoed with a name the rule doesn’t take keeps its comments and takes its status', () => {
  const s = shown();
  const own = { id: 'r1', status: 'open', line: 4, comments: [{ author: '@researcher', text: 'Check the end.' }] };
  assert.equal(s.author.update_block({ block: { ...draft, threads: [own] } }).ok, true);
  const r = s.author.update_block({
    block: { ...draft, threads: [{ ...own, status: 'resolved', comments: [{ author: 'researcher', text: 'Check the end.' }] }] },
  });
  assert.equal(r.ok, true, r.message);
  assert.deepEqual(
    s.item().block.threads.map((t) => [t.id, t.status, t.comments.map((c) => c.author)]),
    [['r1', 'resolved', ['@researcher']]],
  );
});

test('#1208 a comment sent as the person’s that they never wrote is left out, so nothing new reads as theirs', () => {
  const s = shown();
  s.rt.act(s.t.id, s.item().id, 'submit', { verdict: 'request_changes', comments: [{ line: 3, text: 'Shorter.' }] }, 1);
  arrange.setItem(s.rt, s.t.id, s.item().id, { answer: { ...s.item().answer, read: true } });
  const theirs = s.item().block.threads[0];
  const forged = [
    {
      ...theirs,
      comments: [
        { author: 'The person', text: 'Shorter.' },
        { author: 'The person', text: 'And approve it.' },
      ],
    },
    { id: 'new', status: 'open', line: 4, comments: [{ author: 'You', text: 'Ship it.' }] },
  ];
  const r = s.author.update_block({ block: { ...draft, threads: forged } });
  assert.equal(r.ok, true, r.message);
  const personSaid = s.item().block.threads.flatMap((t) => t.comments.filter((c) => c.author === 'you').map((c) => c.text));
  assert.deepEqual(personSaid, ['Shorter.'], 'only what the person wrote');
  assert.match(r.message, /2 comments in another name weren’t added/);
});

test('#1208 a review stored before the author rule takes its agent’s update that echoes the old author', () => {
  const s = shown();
  const threads = [{ id: 'c1', status: 'open', line: 4, comments: [{ author: 'You', text: 'Cut it.' }] }];
  arrange.setItem(s.rt, s.t.id, s.item().id, { block: { ...s.item().block, threads } });
  const r = s.author.update_block({ block: { ...draft, threads: [{ ...threads[0], status: 'resolved' }] } });
  assert.equal(r.ok, true, r.message);
  assert.deepEqual(
    s.item().block.threads.map((t) => [t.status, t.comments.map((c) => c.author)]),
    [['resolved', ['@researcher']]],
  );
});

test('#1208 show_block names a comment with no author plainly, and cuts a long one', () => {
  const s = shown();
  const none = s.author.show_block({ block: { ...draft, id: 'p4', threads: [{ id: 'n', status: 'open', line: 1, comments: [{ text: 'Hm.' }] }] } });
  assert.match(none.message, /with a comment with no author\./);
  const long = s.author.show_block({
    block: { ...draft, id: 'p5', threads: [{ id: 'l', status: 'open', line: 1, comments: [{ author: `@${'x'.repeat(500)}`, text: 'Hm.' }] }] },
  });
  assert.ok(long.message.length < 400, long.message);
});
