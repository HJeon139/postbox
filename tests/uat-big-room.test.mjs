// The big-room seed (#508, tools/uat/big-room.mjs): about 1,000 generated items, the same every run, with the
// landmarks delivery.md and bigroom.md name.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CATCH_UP_ITEMS } from '../server/catch-up.mjs';
import { liveChecks } from '../server/room-checks.mjs';
import { Store } from '../server/store.mjs';
import { parseMentions } from '../shared/text.mjs';
import { bigRoomItems, FIRST_DAY_WORD, seedBigRoom, seedBigRoomData } from '../tools/uat/big-room.mjs';
import { setup, turn } from './blocks-fixture.mjs';

const HANDLES = ['researcher', 'critic', 'developer'];

test('the big room is about 1,000 items, in order, each with its own id, and the same every run', () => {
  const { items } = bigRoomItems();
  assert.equal(items.length, 1000);
  assert.equal(new Set(items.map((it) => it.id)).size, 1000);
  assert.ok(items.every((it, i) => i === 0 || it.at > items[i - 1].at));
  assert.deepEqual(bigRoomItems(), { items, landmarks: bigRoomItems().landmarks });
});

test('its oldest addressed item is a mention of @researcher, with more than the catch-up’s cap after it', () => {
  const { items, landmarks } = bigRoomItems();
  const addressed = items.filter((it) => typeof it.text === 'string' && parseMentions(it.text, HANDLES).length);
  assert.equal(addressed[0].id, landmarks.mention);
  assert.deepEqual(parseMentions(addressed[0].text, HANDLES), ['researcher']);
  assert.equal(addressed.filter((it) => parseMentions(it.text, HANDLES).includes('researcher')).length, 1, 'no later mention of it to find instead');
  assert.ok(items.length - 1 > CATCH_UP_ITEMS);
});

test('it holds a review block from @researcher near its start, and a decision to link to', () => {
  const { items, landmarks } = bigRoomItems();
  const at = (id) => items.findIndex((it) => it.id === id);
  const review = items[at(landmarks.review)];
  assert.ok(at(landmarks.review) < 10);
  assert.equal(review.block.type, 'review');
  assert.equal(review.handle, 'researcher');
  assert.match(items[at(landmarks.decision)].text, /^Decision:/);
});

test('only its first day uses the search phase’s word', () => {
  const { items } = bigRoomItems();
  const day = 24 * 60 * 60 * 1000;
  const using = items.filter((it) => String(it.text ?? '').includes(FIRST_DAY_WORD));
  assert.ok(using.length > 1);
  assert.ok(using.every((it) => it.at < items[0].at + day));
});

test('seeding writes the room into a store’s conversation', () => {
  const store = new Store(null);
  store.emit('thread', { id: 'th_big', kind: 'room', title: 'The release, in a long room', members: [] });
  const landmarks = seedBigRoom(store, 'th_big');
  assert.equal(store.items('th_big').length, 1000);
  assert.equal(store.items('th_big')[0].id, landmarks.mention);
});

/** A conversation the page started: a room and its agents' sessions in it. @param {Store} store */
function startRoom(store) {
  store.emit('thread', { id: 'th_big', kind: 'room', title: 'The release, in a long room', members: ['se_r', 'se_c'] });
  store.emit('session', { id: 'se_r', threadId: 'th_big', handle: 'researcher', personaId: 'pe_r' });
  store.emit('session', { id: 'se_c', threadId: 'th_big', handle: 'critic', personaId: 'pe_c' });
}

test('an agent’s seeded items and its review block are its session’s, so it can revise the block', () => {
  const store = new Store(null);
  startRoom(store);
  const landmarks = seedBigRoom(
    store,
    'th_big',
    { handles: ['researcher', 'critic'] },
    { researcher: { sessionId: 'se_r', personaId: 'pe_r' }, critic: { sessionId: 'se_c', personaId: 'pe_c' } },
  );
  const review = store.item('th_big', landmarks.review);
  assert.equal(review.sessionId, 'se_r');
  assert.equal(review.personaId, 'pe_r');
  const byAgents = store.items('th_big').filter((it) => it.handle);
  assert.ok(byAgents.length > 100);
  assert.ok(byAgents.every((it) => it.sessionId === (it.handle === 'researcher' ? 'se_r' : 'se_c')));
});

test('seeding a run’s data folder while Postbox is down writes the room for the next start to load', async () => {
  const data = mkdtempSync(join(tmpdir(), 'pb-big-room-'));
  try {
    const before = await new Store(data).load();
    startRoom(before);
    await before.close();
    const seeded = await seedBigRoomData(data, 'th_big', ['researcher', 'critic']);
    const after = await new Store(data).load();
    assert.equal(after.items('th_big').length, 1000);
    assert.equal(after.item('th_big', seeded.landmarks.review).sessionId, 'se_r');
    assert.match(seeded.note('http://127.0.0.1:4310'), new RegExp(`http://127\\.0\\.0\\.1:4310/#/t/th_big\\?at=${seeded.landmarks.decision}`));
    await after.close();
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

// The critic’s finding on the harness (#508): the seed’s review block was unanswered, so needs-mismatch fired on every
// run that used the seed, a finding the seed caused and not Postbox. Seeded and left alone, the room raises nothing.
test('a freshly seeded big room, with no agent activity, raises no needs-mismatch or other state finding', () => {
  const store = new Store(null);
  startRoom(store);
  seedBigRoom(
    store,
    'th_big',
    { handles: ['researcher', 'critic'] },
    { researcher: { sessionId: 'se_r', personaId: 'pe_r' }, critic: { sessionId: 'se_c', personaId: 'pe_c' } },
  );
  const { findings, ran } = liveChecks({ state: store.state, threads: ['th_big'] }, ['state', 'threads']);
  assert.ok(ran.includes('needs-mismatch'));
  assert.deepEqual(
    findings.filter((x) => x.check === 'needs-mismatch').map((x) => x.key),
    [],
  );
  assert.deepEqual(
    findings.map((x) => `${x.check}: ${x.title}`),
    [],
  );
});

test('the seeded review is answered as the person’s answer records it, and its agent can still revise it (bigroom.md, phase 3)', async () => {
  const { rt, store, t, adapter } = setup();
  const se = Object.values(store.state.sessions).find((s) => s.threadId === t.id);
  const landmarks = seedBigRoom(store, t.id, { handles: ['critic'] }, { critic: { sessionId: se.id, personaId: se.personaId } });
  const seeded = store.item(t.id, landmarks.review);
  assert.equal(seeded.answered, true);
  assert.equal(seeded.answer.read, true, 'an answer the agent hasn’t read would block its revision');
  assert.equal(seeded.answer.action, 'submit');
  const revised = await turn(rt, adapter, t, (tools) =>
    tools.update_block({ block: { ...seeded.block, content: '# Release plan\n\n1. Freeze.\n2. Tag.\n3. Announce.\n4. Watch.\n' } }),
  );
  assert.equal(revised.ok, true, revised.message);
  assert.match(revised.message, /asks again at the newest point/);
  const items = store.items(t.id);
  const now = store.item(t.id, landmarks.review);
  assert.equal(now.answered, false);
  assert.equal(now.revision, 2);
  assert.equal(items.filter((i) => i.id === landmarks.review).length, 1, 'one live copy');
  assert.ok(
    items.some((i) => i.kind === 'moved' && i.itemId === landmarks.review),
    'a stub where it was',
  );
});
