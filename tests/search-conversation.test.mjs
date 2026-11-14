// search_conversation (#1340, CX-5 of #508; server/search-conversation.mjs): an agent finds an item of its conversation,
// or of one of its topic threads, by words, here and on a host. Each test fails without the tool, since an agent could
// only page through the conversation in order before it.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeTool } from '../server/tool-labels.mjs';
import { TOOL_DEFS } from '../shared/mcp-tools.mjs';
import { rig, running, settled, until } from './remote-turns-helpers.mjs';
import { setup } from './side-threads-fixture.mjs';

/** A conversation with one decision far back, behind enough filler that a page of read_conversation doesn’t reach it. */
function longRoom() {
  const f = setup();
  const decision = f.rt.addItem(f.t.id, { kind: 'user', text: 'Decision: the retry limit is seven, after the outage on the staging cluster.' });
  for (let i = 0; i < 120; i++) f.rt.addItem(f.t.id, { kind: 'user', text: `Note ${i}: checked the changelog and the release notes.` });
  return { ...f, decision, tools: f.rt.toolsFor(f.alpha.id) };
}

test('#1340: search_conversation finds an item far back by its words, with its id, who wrote it and a snippet', () => {
  const { tools, decision } = longRoom();
  const found = tools.search_conversation({ query: 'retry limit' });
  assert.equal(found.ok, true, found.message);
  const first = found.message.split('\n\n')[1];
  assert.match(first, new RegExp(`^\\[${decision.id}\\] `), 'the best hit leads, by its id, which read_message takes');
  assert.match(first, /You: .*the retry limit is seven/, 'who wrote it, and the words around the match');
  assert.match(found.message, /^1 item matches “retry limit”/);
});

test('#1340: a search covers the conversation’s topic threads, and says which thread a hit is in', () => {
  const { rt, t, tools, decision } = longRoom();
  const topic = rt.s.threads[rt.startTopic(t.id, decision.id).threadId];
  rt.addItem(topic.id, { kind: 'user', text: 'In this thread: the quorum size stays at three.' });
  const found = tools.search_conversation({ query: 'quorum' });
  assert.match(found.message, new RegExp(`in the thread “[^”]+” \\(${topic.id}\\)`));
  assert.match(found.message, /the quorum size stays at three/);
});

test('#1340: a search reads only the agent’s own conversation', () => {
  const { rt, a, tools } = longRoom();
  const other = rt.createThread({ projectId: 'p1', title: 'Elsewhere', personaIds: [a.id] });
  rt.addItem(other.id, { kind: 'user', text: 'The vault passphrase rotates on Fridays.' });
  assert.match(tools.search_conversation({ query: 'passphrase' }).message, /^Nothing in this conversation matches “passphrase”\./);
});

test('#1340: a search with no query is refused, and a long one is cut where it enters', () => {
  const { tools } = longRoom();
  const none = tools.search_conversation({});
  assert.deepEqual([none.ok, /needs a query/.test(none.message)], [false, true]);
  const long = tools.search_conversation({ query: `retry ${'x'.repeat(5000)}`, limit: 1000 });
  assert.equal(long.ok, true);
  assert.ok(long.message.length < 2000, 'the answer doesn’t repeat a 5,000-character query');
});

test('#1340: a snippet of a long item shows the words that matched, not only its start', () => {
  const { rt, t, tools } = longRoom();
  rt.addItem(t.id, {
    kind: 'user',
    text: `${'Filler sentence about packaging. '.repeat(60)}The zephyrine milestone ships in March. ${'More filler. '.repeat(60)}`,
  });
  const found = tools.search_conversation({ query: 'zephyrine' });
  assert.match(found.message, /…[^\n]*The zephyrine milestone ships in March/);
  assert.match(found.message, /read_message \{ id: "it_[^"]+" \} has all of it/);
});

test('#1340: the tool is described to agents, with its limits', () => {
  const def = TOOL_DEFS.find((d) => d.name === 'search_conversation');
  assert.ok(def, 'in the tools every backend is given');
  assert.deepEqual(def.inputSchema.required, ['query']);
});

test('#1340: an agent on a host searches its conversation too: search_conversation crosses to Postbox', async () => {
  const r = rig();
  const turn = await running(r);
  r.rt.addItem(r.t.id, { kind: 'user', text: 'Decision: the retry limit is seven.' });
  const id = r.d.tool(turn, 'search_conversation', { query: 'retry limit' });
  await until(() => r.d.replies.some((x) => x.id === id), 'the search’s reply');
  const found = r.d.replies.find((x) => x.id === id);
  assert.equal(found.ok, true, found.text);
  assert.match(found.text, /the retry limit is seven/);
  r.d.end(turn);
  await settled(r);
});

test('#1340: a search shows in the activity list as what was searched for', () => {
  assert.equal(describeTool('mcp__postbox__search_conversation', { query: 'retry limit' }), 'Searched the conversation for “retry limit”');
});
