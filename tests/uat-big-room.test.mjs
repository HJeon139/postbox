// The big-room seed (#508, tools/uat/big-room.mjs): about 1,000 generated items, the same every run, with the
// landmarks delivery.md and bigroom.md name.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CATCH_UP_ITEMS } from '../server/catch-up.mjs';
import { Store } from '../server/store.mjs';
import { parseMentions } from '../shared/text.mjs';
import { bigRoomItems, FIRST_DAY_WORD, seedBigRoom, seedBigRoomData } from '../tools/uat/big-room.mjs';

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
    await before.flush();
    const seeded = await seedBigRoomData(data, 'th_big', ['researcher', 'critic']);
    const after = await new Store(data).load();
    assert.equal(after.items('th_big').length, 1000);
    assert.equal(after.item('th_big', seeded.landmarks.review).sessionId, 'se_r');
    assert.match(seeded.note('http://127.0.0.1:4310'), new RegExp(`http://127\\.0\\.0\\.1:4310/#/t/th_big\\?at=${seeded.landmarks.decision}`));
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});
