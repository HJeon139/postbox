// #858: the person corrects a comment of theirs on a review after they submitted it. Their comment stays as written,
// since their answer belongs to the revision they saw and the agent has read it; the correction follows it in the same
// thread, marked edited, and the agent hears an event that names the comment it replaces.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import * as arrange from './arrange.mjs';

const DRAFT = ['# Plan', '', 'We index first.', 'Last line.'].join('\n');
const draft = { id: 'plan', type: 'review', version: 1, title: 'plan.md', fallback: 'The plan', format: 'markdown', content: DRAFT };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A conversation with @researcher’s review, which the person has answered with one comment on line 3. */
async function answered() {
  const store = new Store(null);
  /** @type {any[]} */
  const heard = [];
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register({
      name: 'mock',
      async folderFor() {},
      fork() {},
      async deliver(_session, message) {
        heard.push(message);
      },
    }),
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0 },
  });
  store.emit('project', { id: 'p1', name: 'P', folder: '/tmp' });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [rt.createPersona({ handle: 'researcher' }).id] });
  const se = arrange.agentIn(rt, t.id, 'researcher');
  assert.equal(rt.toolsFor(se.id).show_block({ block: draft }).ok, true);
  const item = () => store.items(t.id).find((i) => i.kind === 'block' && i.block.id === 'plan');
  rt.act(t.id, item().id, 'submit', { verdict: 'request_changes', comments: [{ line: 3, text: 'Say what we index.' }] }, 1);
  const events = async () => {
    for (let i = 0; i < 100 && !heard.some((m) => m.event?.action === 'correct'); i++) await sleep(5);
    return heard.filter((m) => m.kind === 'event' && m.event?.action === 'correct').map((m) => m.event);
  };
  return { rt, t, se, item, events, threadId: item().block.threads[0].id };
}

test('#858 a correction follows the person’s comment, marked edited, and the agent hears what it replaces', async () => {
  const s = await answered();
  assert.deepEqual(s.rt.act(s.t.id, s.item().id, '@correct', { threadId: s.threadId, text: '  Say which papers we index.  ' }), { ok: true });
  assert.deepEqual(
    s.item().block.threads[0].comments.map((c) => [c.author, c.text, c.edited ?? false]),
    [
      ['you', 'Say what we index.', false],
      ['you', 'Say which papers we index.', true],
    ],
    'the comment stays as written, and the correction follows it',
  );
  assert.equal(s.item().answer.values.comments[0].text, 'Say what we index.', 'the answer is as the person sent it');
  const [event] = await s.events();
  assert.deepEqual(event, {
    blockId: 'plan',
    revision: 1,
    action: 'correct',
    values: { threadId: s.threadId, line: 3, replaces: 'Say what we index.', text: 'Say which papers we index.' },
  });
});

test('#858 a second correction replaces the first, and one that changes nothing adds nothing', async () => {
  const s = await answered();
  s.rt.act(s.t.id, s.item().id, '@correct', { threadId: s.threadId, text: 'Second try.' });
  s.rt.act(s.t.id, s.item().id, '@correct', { threadId: s.threadId, text: 'Third try.' });
  assert.deepEqual(s.rt.act(s.t.id, s.item().id, '@correct', { threadId: s.threadId, text: 'Third try.' }), { ok: true, unchanged: true });
  assert.deepEqual(
    s.item().block.threads[0].comments.map((c) => c.text),
    ['Say what we index.', 'Second try.', 'Third try.'],
  );
  assert.deepEqual(
    (await s.events()).map((e) => [e.values.replaces, e.values.text]),
    [
      ['Say what we index.', 'Second try.'],
      ['Second try.', 'Third try.'],
    ],
  );
});

test('#858 only the person’s own comment on a review can be corrected, with words in it', async () => {
  const s = await answered();
  const refused = (values, status, words) =>
    assert.throws(
      () => s.rt.act(s.t.id, s.item().id, '@correct', values),
      (e) => e.status === status && words.test(e.message),
    );
  refused({ threadId: s.threadId, text: '   ' }, 422, /^The correction is empty\./);
  refused({ threadId: s.threadId, text: 'x'.repeat(4001) }, 422, /longer than 4000/);
  refused({ threadId: 'no-such-thread', text: 'Hm.' }, 404, /isn’t a comment of yours/);
  // A thread of the agent’s own, with no comment of the person’s in it.
  const own = { id: 'r1', status: 'open', line: 4, comments: [{ author: '@researcher', text: 'Check the end.' }] };
  const threads = [...s.item().block.threads, own];
  assert.equal(s.rt.toolsFor(s.se.id).update_block({ block: { ...draft, content: `${DRAFT}\n`, threads } }).ok, true);
  refused({ threadId: 'r1', text: 'Mine now.' }, 404, /isn’t a comment of yours/);
  assert.deepEqual(await s.events(), [], 'the agent heard nothing');
});

test('#858 an agent that echoes the threads with a correction in them has its update applied', async () => {
  const s = await answered();
  s.rt.act(s.t.id, s.item().id, '@correct', { threadId: s.threadId, text: 'Say which papers we index.' });
  arrange.setItem(s.rt, s.t.id, s.item().id, { answer: { ...s.item().answer, read: true } });
  const echoed = { ...s.item().block.threads[0], status: 'resolved' };
  const r = s.rt.toolsFor(s.se.id).update_block({ block: { ...draft, content: DRAFT.replace('first', 'papers first'), threads: [echoed] } });
  assert.equal(r.ok, true, r.message);
  assert.deepEqual(
    s.item().block.threads[0].comments.map((c) => [c.text, c.edited ?? false]),
    [
      ['Say what we index.', false],
      ['Say which papers we index.', true],
    ],
  );
});

test('#858 a correction that would take a thread past its 50 comments is refused, and the review stays usable', async () => {
  const s = await answered();
  for (let i = 1; i < 50; i++) s.rt.act(s.t.id, s.item().id, '@correct', { threadId: s.threadId, text: `Try ${i}.` });
  assert.equal(s.item().block.threads[0].comments.length, 50);
  assert.throws(
    () => s.rt.act(s.t.id, s.item().id, '@correct', { threadId: s.threadId, text: 'One too many.' }),
    (e) =>
      e.status === 422 && /Your correction wasn’t sent: this review can’t hold another comment\. .* Ask @researcher to show a new review block/.test(e.message),
  );
  assert.equal(s.item().block.threads[0].comments.length, 50, 'nothing was added');
  arrange.setItem(s.rt, s.t.id, s.item().id, { answer: { ...s.item().answer, read: true } });
  assert.equal(s.rt.toolsFor(s.se.id).update_block({ block: { ...draft, content: `${DRAFT}\n` } }).ok, true, 'its agent can still update it');
});

test('#858 a card action with the id “correct” still reaches the agent as a click', async () => {
  const s = await answered();
  const card = { id: 'c1', type: 'card', version: 1, fallback: 'Fix it?', actions: [{ id: 'correct', label: 'Correct it' }] };
  assert.equal(s.rt.toolsFor(s.se.id).show_block({ block: card }).ok, true);
  const item = s.rt.store.items(s.t.id).find((i) => i.kind === 'block' && i.block.id === 'c1');
  assert.equal(s.rt.act(s.t.id, item.id, 'correct', {}).ok, true);
});

test('#858 an agent can’t mark a comment of its own edited, and a withdrawn review takes no correction', async () => {
  const s = await answered();
  const marked = { id: 'r1', status: 'open', line: 4, comments: [{ author: '@researcher', text: 'Check the end.', edited: true }] };
  const shown = s.rt.toolsFor(s.se.id).show_block({ block: { ...draft, id: 'plan-2', threads: [marked] } });
  assert.equal(shown.ok, false);
  assert.match(shown.message, /only the person’s correction is marked edited/);
  arrange.setItem(s.rt, s.t.id, s.item().id, { closed: { by: 'agent', handle: 'researcher', at: Date.now() } });
  assert.throws(
    () => s.rt.act(s.t.id, s.item().id, '@correct', { threadId: s.threadId, text: 'Too late.' }),
    (e) => e.status === 409 && /@researcher withdrew this review/.test(e.message),
  );
});

test('#858 a correction on a block that isn’t a review, or from a retired session’s review, is refused', async () => {
  const s = await answered();
  const choice = { id: 'pick', type: 'choice', version: 1, fallback: 'Pick one', options: [{ id: 'a', label: 'A' }] };
  assert.equal(s.rt.toolsFor(s.se.id).show_block({ block: choice }).ok, true);
  const picked = s.rt.store.items(s.t.id).find((i) => i.kind === 'block' && i.block.id === 'pick');
  assert.throws(
    () => s.rt.act(s.t.id, picked.id, '@correct', { threadId: s.threadId, text: 'Hm.' }),
    (e) => e.status === 409 && /^Only a comment on a review can be corrected\./.test(e.message),
  );
  arrange.setSession(s.rt, s.se.id, { retiredFork: true });
  assert.throws(() => s.rt.act(s.t.id, s.item().id, '@correct', { threadId: s.threadId, text: 'Too late.' }), /retired|fork/i);
  assert.equal(s.item().block.threads[0].comments.length, 1, 'nothing was added');
  assert.deepEqual(await s.events(), []);
});
