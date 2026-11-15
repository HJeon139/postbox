// What the inbox’s build must show, counted from a UAT run’s records (tools/uat/inbox-measures.mjs;
// designs/rooms-at-scale.md, “What the build must show”). Each measure is held on records small enough to read.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  across,
  copyWakes,
  crossed,
  doubledHandOffs,
  idleWakes,
  itemsOf,
  promptTokens,
  readsAfterWake,
  table,
  waitingElsewhere,
} from '../tools/uat/inbox-measures.mjs';
import { toolName } from '../tools/uat/run-turns.mjs';

const agent = (id, handle, at, text, more = {}) => ({ id, kind: 'agent', handle, at, text, turnId: `turn_${id}`, ...more });
const person = (id, at, text) => ({ id, kind: 'user', at, text });

test('an item’s text is what streamed into it, and a patch is applied', () => {
  const events = [
    { type: 'item.add', data: { threadId: 'th_1', item: { id: 'it_a', kind: 'agent', handle: 'alpha', at: 5, text: '' } } },
    { type: 'item.text', data: { id: 'it_a', text: 'Hello ' } },
    { type: 'item.text', data: { id: 'it_a', text: '@beta' } },
    { type: 'item.patch', data: { id: 'it_a', patch: { woke: { by: 'beta' } } } },
  ];
  assert.deepEqual(itemsOf(events), [{ id: 'it_a', kind: 'agent', handle: 'alpha', at: 5, text: 'Hello @beta', threadId: 'th_1', woke: { by: 'beta' } }]);
});

test('a tool has one name on every harness', () => {
  assert.deepEqual(['mcp__postbox__read_message', 'postbox.read_message', 'pb.read_message', 'Bash'].map(toolName), [
    'read_message',
    'read_message',
    'read_message',
    'Bash',
  ]);
});

test('a reply crossed a message when one to its agent was posted after its turn started and before the reply', () => {
  const items = [person('it_1', 10, '@alpha start'), agent('it_2', 'beta', 25, '@alpha one more thing'), agent('it_3', 'alpha', 30, 'Done.')];
  assert.equal(crossed(items, [{ handle: 'alpha', started: 20 }]), 1);
  // The same message before the turn started was in the turn’s input.
  assert.equal(crossed(items, [{ handle: 'alpha', started: 26 }]), 0);
  // A message to another agent crosses nothing.
  assert.equal(crossed([items[0], agent('it_2', 'beta', 25, '@gamma look'), agent('it_g', 'gamma', 1, ''), items[2]], [{ handle: 'alpha', started: 20 }]), 0);
});

test('a wake found nothing to do when the woken turn called no tool and only acknowledged', () => {
  const ack = agent('it_1', 'beta', 10, 'Acknowledged. Nothing needed from me here.', { woke: { by: 'alpha' } });
  const worked = agent('it_2', 'beta', 20, 'Acknowledged.', { woke: { by: 'alpha' } });
  const long = agent('it_3', 'beta', 30, 'x'.repeat(201), { woke: { by: 'alpha' } });
  const asked = agent('it_4', 'beta', 40, 'Fine.');
  const turns = [{ turnId: 'turn_it_2', tools: ['read_message'] }];
  assert.equal(idleWakes([ack, worked, long, asked], turns), 1);
  // A turn that posted two items is one wake, and its words are counted together.
  const again = { ...ack, id: 'it_1b', text: 'Still nothing.' };
  assert.equal(idleWakes([ack, again], []), 1);
  assert.equal(idleWakes([ack, { ...again, text: 'y'.repeat(200) }], []), 0);
});

test('a hand-off is posted twice when a turn calls wake_agent and its reply mentions an agent too', () => {
  const items = [agent('it_1', 'alpha', 10, '@beta please review'), agent('it_2', 'alpha', 20, 'Done, nothing to hand off.'), agent('it_b', 'beta', 1, '')];
  const turns = [
    { turnId: 'turn_it_1', tools: ['wake_agent'] },
    { turnId: 'turn_it_2', tools: ['wake_agent'] },
  ];
  assert.equal(doubledHandOffs(items, turns), 1);
  assert.equal(doubledHandOffs(items, [{ turnId: 'turn_it_1', tools: ['read_message'] }]), 0);
});

test('a wake is by a copied line when the waking reply names the agent only in a line copied from the conversation', () => {
  const said = agent('it_big0137', 'beta', 1, 'I reran the migration guide; item 137 of the release log.');
  const copy = agent('it_2', 'alpha', 10, 'it_big0137: @beta: I reran the migration guide; item 137 of the release log.');
  const woken = agent('it_3', 'beta', 20, 'Acknowledged.', { woke: { by: 'alpha' } });
  assert.equal(copyWakes([said, copy, woken]), 1);
  const handOff = agent('it_2', 'alpha', 10, 'it_big0137: @beta: can you rerun it for 2.1?');
  assert.equal(copyWakes([said, handOff, woken]), 0);
  assert.equal(copyWakes([said, copy, woken, { ...woken, id: 'it_4', at: 21 }]), 1, 'two items of one woken turn are one wake');
});

test('reads after a wake are the catch-up reads before the first other action, in woken turns only', () => {
  const items = [
    agent('it_1', 'beta', 10, 'ok', { woke: { by: 'alpha' } }),
    agent('it_2', 'beta', 20, 'ok', { woke: { by: 'alpha' } }),
    agent('it_3', 'beta', 30, 'ok'),
  ];
  const turns = [
    { turnId: 'turn_it_1', tools: ['read_conversation', 'read_message', 'Bash', 'read_message'] },
    { turnId: 'turn_it_2', tools: ['read_message'] },
    { turnId: 'turn_it_3', tools: ['read_message', 'read_message'] },
  ];
  assert.deepEqual(readsAfterWake(items, turns), [2, 1]);
});

test('entries waiting in another thread are counted once a turn, after its take', () => {
  const add = (id, threadId) => ({ type: 'entry.add', data: { sessionId: 'se_a', entry: { id, threadId, state: 'waiting', takenBy: null } } });
  const take = (id, turn) => ({ type: 'entry.patch', data: { sessionId: 'se_a', id, patch: { state: 'taken', takenBy: turn } } });
  const events = [
    add('en_1', 'th_topic'),
    add('en_2', 'th_topic'),
    add('en_3', 'th_main'),
    { type: 'entry.add', data: { sessionId: 'se_b', entry: { id: 'en_9', threadId: 'th_main', state: 'waiting' } } },
    take('en_1', 'turn_1'),
    take('en_2', 'turn_1'),
    { type: 'entry.patch', data: { sessionId: 'se_a', id: 'en_1', patch: { state: 'delivered' } } },
    take('en_3', 'turn_2'),
  ];
  assert.deepEqual(waitingElsewhere(events), [1, 0]);
  assert.deepEqual(waitingElsewhere([{ type: 'item.add', data: {} }]), [], 'a run before the inbox has none');
  // A notice rides a take whatever its thread: it isn’t waiting elsewhere, before it is patched or after.
  const notice = { type: 'entry.add', data: { sessionId: 'se_a', entry: { id: 'en_n', threadId: 'th_main', source: 'notice', state: 'waiting' } } };
  assert.deepEqual(waitingElsewhere([add('en_1', 'th_topic'), notice, take('en_n', 'turn_1'), take('en_1', 'turn_1')]), [0], 'a notice taken first');
  assert.deepEqual(waitingElsewhere([add('en_1', 'th_topic'), notice, take('en_1', 'turn_1'), take('en_n', 'turn_1')]), [0], 'a notice taken last');
  assert.deepEqual(waitingElsewhere([add('en_1', 'th_topic'), add('en_3', 'th_main'), notice, take('en_1', 'turn_1')]), [1], 'a notice left waiting');
  // An entry the person’s Stop stopped starts no turn, so it isn’t waiting anywhere.
  const stop = { type: 'entry.patch', data: { sessionId: 'se_a', id: 'en_3', patch: { state: 'stopped' } } };
  assert.deepEqual(waitingElsewhere([add('en_1', 'th_topic'), add('en_3', 'th_main'), stop, take('en_1', 'turn_1')]), [0], 'a stopped entry');
});

test('Postbox’s input is each prompt’s size, without what the agent’s own tools returned', () => {
  const transcript = [
    { type: 'user', message: { content: 'x'.repeat(400) } },
    { type: 'assistant', message: { content: [] } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'y'.repeat(4000) }] } },
    { type: 'user', message: { content: [{ type: 'text', text: 'z'.repeat(80) }] } },
  ];
  assert.deepEqual(promptTokens(transcript), [100, 20]);
});

test('a measure across runs is its mean and range, and the table says when nothing recorded it', () => {
  assert.equal(across([{ crossed: 2 }, { crossed: 4 }, { crossed: 3 }], 'crossed'), '3 (2 to 4)');
  assert.equal(across([{ requestsPerTurn: 6.7 }], 'requestsPerTurn'), '6.7');
  assert.equal(across([{ inputTokensPerTurn: 142991.2 }, { inputTokensPerTurn: 217483.9 }], 'inputTokensPerTurn'), '180,238 (142,991 to 217,484)');
  assert.equal(across([{ waitingElsewhere: null }], 'waitingElsewhere'), 'not recorded');
  const row = table([{ waitingElsewhere: null }], [{ waitingElsewhere: 0.5 }, { waitingElsewhere: 1.5 }])
    .split('\n')
    .at(-1);
  assert.equal(row, '| Entries waiting in another thread at a turn’s start | not recorded | 1 (0.5 to 1.5) | reported |');
});
