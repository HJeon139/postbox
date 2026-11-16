// A copy of a line of the conversation names its agent without waking it, and a hand-off that only looks like one
// still wakes (#1370; server/copied-line.mjs, parseMentions in shared/text.mjs).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copiedLine } from '../server/copied-line.mjs';
import { entryLine } from '../server/turn-input.mjs';
import { parseMentions } from '../shared/text.mjs';
import { post } from './arrange.mjs';
import { settle, setup } from './side-threads-fixture.mjs';

const RERAN = 'I reran the migration guide for the zephyrine milestone; item 137 of the release log. Nothing here needs anyone yet.';

/** A conversation where @beta said one thing, read as @alpha, and what @alpha’s message would wake. */
function room() {
  const f = setup();
  const said = post(f.rt, f.t.id, { kind: 'agent', sessionId: f.beta.id, personaId: f.beta.personaId, handle: 'beta', text: RERAN, status: 'done' });
  const wakes = (/** @type {string} */ text) => parseMentions(text, ['alpha', 'beta', 'gamma'], copiedLine(f.rt, f.alpha));
  return { ...f, said, wakes, tools: f.rt.toolsFor(f.alpha.id) };
}

test('#1370: the reply that woke an agent unasked in the search measurement, an id and then the line, wakes no one', () => {
  const { said, wakes } = room();
  assert.deepEqual(wakes(`${said.id}: @beta: ${RERAN}`), []);
  assert.deepEqual(wakes(`Found it:\n- [${said.id}] @beta: ${RERAN}\n\n@gamma is that the one?`), ['gamma']);
});

test('#1370: every line read_conversation and search_conversation give, copied back, wakes no one', () => {
  const { rt, t, said, beta, wakes, tools } = room();
  post(rt, t.id, { kind: 'user', text: '@beta and @gamma, which milestone is this for?' });
  post(rt, t.id, { kind: 'agent', sessionId: beta.id, personaId: beta.personaId, handle: 'beta', text: `@gamma ${'long '.repeat(600)}`, status: 'done' });
  const topic = rt.s.threads[rt.startTopic(t.id, said.id).threadId];
  post(rt, topic.id, {
    kind: 'agent',
    sessionId: beta.id,
    personaId: beta.personaId,
    handle: 'beta',
    text: 'In the thread: @gamma owns the zephyrine guide.',
    status: 'done',
  });
  const read = tools.read_conversation({}).message;
  const lines = read.split('\n').filter((l) => /^\[it_/.test(l));
  assert.ok(lines.length >= 3 && lines.some((l) => l.includes('characters')), 'the lines it gave, one of them cut');
  for (const line of lines) assert.deepEqual(wakes(line), [], line.slice(0, 80));
  const hits = tools
    .search_conversation({ query: 'zephyrine' })
    .message.split('\n\n')
    .filter((l) => /^\[it_/.test(l));
  assert.ok(hits.length >= 2 && hits.some((l) => l.includes('in the thread')), 'a hit in the conversation and one in its topic thread');
  for (const hit of hits) assert.deepEqual(wakes(hit), [], hit.slice(0, 80));
});

test('#1370: a hand-off that names an item wakes: other words after the id, an id that isn’t an item’s, or a question added', () => {
  const { said, wakes } = room();
  assert.deepEqual(wakes(`- ${said.id}: @beta: fix the null check\n- it_ijklmnop: @gamma: re-review`), ['beta', 'gamma']);
  assert.deepEqual(wakes(`[${said.id}] @beta please look`), ['beta']);
  assert.deepEqual(wakes(`${said.id} @beta: can you fix the bug you posted there?`), ['beta']);
  assert.deepEqual(wakes(`it_nothere1: @beta: ${RERAN}`), ['beta']);
  assert.deepEqual(wakes(`${said.id}: @beta: ${RERAN} Can you rerun it for 2.1?`), ['beta']);
  assert.deepEqual(wakes(`${said.id}: @beta: …`), ['beta']);
  assert.deepEqual(wakes(`[${said.id}] @beta`), ['beta']);
});

test('#1370: a copy of another conversation’s item wakes: only this conversation’s items are checked', () => {
  const { rt, store, wakes } = room();
  const other = rt.createThread({ projectId: Object.keys(store.state.projects)[0], title: 'Elsewhere', personaIds: [] });
  const there = post(rt, other.id, { kind: 'user', text: 'Elsewhere: @beta owns the changelog for the other release.' });
  assert.deepEqual(wakes(`[${there.id}] The person: Elsewhere: @beta owns the changelog for the other release.`), ['beta']);
});

test('#1370: a message’s lines are checked against the conversation’s threads worked out once, and not at all with no line to check', () => {
  const { rt, said, alpha } = room();
  let lookups = 0;
  const found = rt.threads.conversationThreads.bind(rt.threads);
  rt.threads.conversationThreads = (/** @type {string} */ id) => {
    lookups++;
    return found(id);
  };
  const handles = ['alpha', 'beta', 'gamma'];
  const lines = Array.from({ length: 50 }, () => `${said.id}: @beta: ${RERAN}`).join('\n');
  assert.deepEqual(parseMentions(lines, handles, copiedLine(rt, alpha)), []);
  assert.equal(lookups, 1, 'one lookup for 50 lines');
  assert.deepEqual(parseMentions('@beta over to you', handles, copiedLine(rt, alpha)), ['beta']);
  assert.equal(lookups, 1, 'none for a message with no line that starts with an id');
});

/** Whom alpha’s turn woke, when its reply is what `text` makes of beta’s earlier message. */
async function replyWakes(text) {
  const f = setup();
  const said = post(f.rt, f.t.id, { kind: 'agent', sessionId: f.beta.id, personaId: f.beta.personaId, handle: 'beta', text: RERAN, status: 'done' });
  f.adapter.next.push(async (c) => c.text(text(said)));
  f.rt.sendMessage(f.t.id, { text: '@alpha find item 137 and reply with its id and its exact text' });
  await settle(f.rt);
  return f.adapter.calls.filter((c) => c.sessionId === f.beta.id).length;
}

test('#1370: an agent’s reply that copies another agent’s line doesn’t wake it, and a hand-off that names the item does', async () => {
  assert.equal(await replyWakes((said) => `${said.id}: @beta: ${RERAN}`), 0, 'the copied line woke no one');
  assert.equal(await replyWakes((said) => `${said.id}: @beta: can you rerun it for 2.1?`), 1, 'the hand-off woke beta');
});

// What a turn is given names who an entry is from with its time and what it is (server/turn-input.mjs), so a copy of
// one must be read as a copy too, or it wakes as the lines before it did.
test('#1370: an entry’s line as a turn gives it, copied back, wakes no one, and a hand-off in its shape still wakes', () => {
  const { said, wakes } = room();
  const at = Date.UTC(2026, 10, 15, 14, 2);
  const entry = { id: 'en_1', threadId: said.threadId, itemId: said.id, from: 'beta', at };
  const read = () => RERAN;
  for (const more of [
    { source: 'mention' },
    { source: 'review' },
    { source: 'mention', resend: true },
    { source: 'mention', postedSince: ['it_900', 'it_901'] },
  ]) {
    const line = entryLine({ ...entry, ...more }, read);
    assert.match(line, /^\[it_\w+\] @beta, /, 'the line names who it is from');
    assert.deepEqual(wakes(line), [], line.slice(0, 90));
  }
  const cut = entryLine({ ...entry, source: 'mention' }, () => `${RERAN} ${'more '.repeat(4000)}`);
  assert.ok(cut.includes('characters; read_message'), 'a cut entry');
  assert.deepEqual(wakes(`[${said.id}] @beta, 14:02 UTC: can you rerun it for 2.1?`), ['beta']);
});

// A message of several lines, copied whole: only its first line starts with the id. In the UAT run of 16 November 2026
// (2026-11-16T02-17-46-inboxroom) an agent copied this message as read_conversation gave it, and the “@gamma” on its
// last line made an entry for that agent.
const CHECKED = [
  'I’ll check the sentence for clarity and accuracy, then ask @gamma which file should hold the changelog entry.',
  '',
  '“Release 2.1 adds search to the conversation.” is clear and concise.',
  '',
  '@gamma Which file should the changelog entry go in?',
].join('\n');

test('#1416: a message of several lines copied whole wakes no one, and the agent’s own line after the copy still wakes', () => {
  const f = setup();
  const said = post(f.rt, f.t.id, { kind: 'agent', sessionId: f.beta.id, personaId: f.beta.personaId, handle: 'beta', text: CHECKED, status: 'done' });
  const wakes = (/** @type {string} */ text) => parseMentions(text, ['alpha', 'beta', 'gamma'], copiedLine(f.rt, f.alpha));
  const copy = `[${said.id}] @beta: ${CHECKED}`;
  assert.deepEqual(wakes(copy), [], 'the copy as the agent posted it');
  // A lost hand-off is worse than an extra wake: words that aren’t the item’s end the copy, and wake.
  assert.deepEqual(wakes(`${copy}\n\n@gamma please answer that today`), ['gamma'], 'the agent’s own line after the copy');
  assert.deepEqual(wakes(`${copy}\n@gamma`), ['gamma'], 'a bare mention after the copy');
  // The copy ends at the first line that isn’t the item’s, so the item’s words after it are the message’s own again.
  assert.deepEqual(wakes(`[${said.id}] @beta: I’ll check the sentence\nNot the item’s words.\n@gamma Which file should the changelog entry go in?`), ['gamma']);
  // The same lines with no copy before them are a hand-off.
  assert.deepEqual(wakes('@gamma Which file should the changelog entry go in?'), ['gamma']);
});
