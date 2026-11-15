// A copy of a line of the conversation names its agent without waking it, and a hand-off that only looks like one
// still wakes (#1370; server/copied-line.mjs, parseMentions in shared/text.mjs).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copiedLine } from '../server/copied-line.mjs';
import { parseMentions } from '../shared/text.mjs';
import { post } from './arrange.mjs';
import { setup } from './side-threads-fixture.mjs';

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
