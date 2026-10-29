// The big-room seed (#508, tools/uat/big-room.mjs): about 1,000 generated items, the same every run, with the
// landmarks delivery.md and bigroom.md name.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CATCH_UP_ITEMS } from '../server/catch-up.mjs';
import { Store } from '../server/store.mjs';
import { parseMentions } from '../shared/text.mjs';
import { bigRoomItems, FIRST_DAY_WORD, seedBigRoom } from '../tools/uat/big-room.mjs';

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
