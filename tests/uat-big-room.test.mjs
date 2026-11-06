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
import { bigRoomItems, FIRST_DAY_WORD, openBigRoom, seedBigRoom, seedBigRoomData } from '../tools/uat/big-room.mjs';
import { setup, turn } from './blocks-fixture.mjs';

const MERMAID = /```mermaid\n/;

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

test('#701: a scenario’s seed-diagrams reaches the run’s store through openBigRoom and seedBigRoomData', async () => {
  const data = mkdtempSync(join(tmpdir(), 'pb-big-room-'));
  try {
    const before = await new Store(data).load();
    startRoom(before);
    await before.close();
    const postbox = {
      origin: 'http://127.0.0.1:4310',
      restart: async ({ whileDown }) => {
        await whileDown();
        return 0;
      },
    };
    const opened = [];
    const scenario = { agents: ['researcher', 'critic'], seedDiagrams: 3 };
    await openBigRoom({ postbox, data, threadId: 'th_big', scenario, page: { goto: async (u) => opened.push(u) }, log: () => {} });
    const after = await new Store(data).load();
    assert.equal(after.items('th_big').filter((it) => MERMAID.test(it.text ?? '')).length, 3);
    assert.deepEqual(opened, ['http://127.0.0.1:4310/#/t/th_big']);
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

// #701’s UAT trigger needs diagrams far above the view; the measured rooms (the key-press tool) stay without them.
test('#701: by default the room has no diagrams; with diagrams: n, n agent replies far apart each end in one, and nothing else changes', () => {
  const plain = bigRoomItems();
  assert.equal(plain.items.filter((it) => MERMAID.test(it.text ?? '')).length, 0);
  const drawn = bigRoomItems({ diagrams: 6 });
  const withDiagram = drawn.items.filter((it) => MERMAID.test(it.text ?? ''));
  assert.equal(withDiagram.length, 6);
  for (const it of withDiagram) assert.equal(it.kind, 'agent');
  const at = withDiagram.map((it) => drawn.items.indexOf(it));
  for (let k = 1; k < at.length; k++) assert.ok(at[k] - at[k - 1] >= 100, `diagrams ${at[k - 1]} and ${at[k]} are far apart`);
  // The same room otherwise: the same ids, kinds and authors, and the same text before the diagram.
  assert.deepEqual(
    drawn.items.map((it) => [it.id, it.kind, it.handle, String(it.text ?? '').split('\n\n```mermaid')[0]]),
    plain.items.map((it) => [it.id, it.kind, it.handle, String(it.text ?? '')]),
  );
});

test('#701: each diagram is in its own reply, however many are asked for, and a room too small for them is refused', () => {
  for (const n of [1, 6, 200, 500]) {
    const drawn = bigRoomItems({ diagrams: n }).items.filter((it) => MERMAID.test(it.text ?? ''));
    assert.equal(drawn.length, n, `${n} replies end in a diagram`);
    for (const it of drawn) assert.equal(it.text.split('```mermaid').length, 2, `${it.id} has one diagram`);
  }
  assert.throws(() => bigRoomItems({ count: 10, diagrams: 6 }), /too few agent replies for 6 diagrams/);
});

test('#701: `- seed-diagrams: n` asks the big room for n diagrams; absent, none; mistyped, it’s refused', async () => {
  const { parseScenario } = await import('../tools/uat/scenario.mjs');
  const head = (extra) => `# Big room\n\n- seed: big-room\n${extra}- steps: 4\n\nRead back.\n`;
  assert.equal(parseScenario(head('')).seedDiagrams, 0);
  assert.equal(parseScenario(head('- seed-diagrams: 6\n')).seedDiagrams, 6);
  for (const bad of ['six', '0', '-2', '1.5']) assert.throws(() => parseScenario(head(`- seed-diagrams: ${bad}\n`)), /seed-diagrams/, bad);
  assert.throws(() => parseScenario('# Plain\n\n- seed-diagrams: 6\n- steps: 4\n\nRead back.\n'), /needs `- seed: big-room`/);
});

// PF-1’s key-to-frame tool (#508, tools/bench-key-frame.mjs) seeds rooms of 4,000 and 10,000 items, and more.
test('a room past 10,000 items keeps its ids in the order of its items, and a 1,000-item room’s ids are unchanged', () => {
  const { items } = bigRoomItems({ count: 10_001 });
  const ids = items.map((it) => it.id);
  assert.deepEqual([...ids].sort(), ids);
  assert.equal(new Set(ids).size, 10_001);
  assert.equal(bigRoomItems().items[0].id, 'it_big0000');
  assert.equal(bigRoomItems().items[999].id, 'it_big0999');
});

test('a room of 9,999 or 10,000 items keeps four-digit ids in the order of its items, and one of 10,001 goes to five', () => {
  for (const count of [9_999, 10_000]) {
    const ids = bigRoomItems({ count }).items.map((it) => it.id);
    assert.deepEqual([...ids].sort(), ids, `${count} items`);
    assert.equal(ids[0], 'it_big0000', `${count} items`);
    assert.equal(ids.at(-1), `it_big${count - 1}`, `${count} items`);
  }
  assert.equal(bigRoomItems({ count: 10_001 }).items.at(-1).id, 'it_big10000');
  assert.equal(bigRoomItems({ count: 10_001 }).items[0].id, 'it_big00000');
});

test('seeding a run’s data folder with another count writes that many items, and its note says how many', async () => {
  const data = mkdtempSync(join(tmpdir(), 'pb-big-room-count-'));
  try {
    const before = await new Store(data).load();
    startRoom(before);
    await before.close();
    const seeded = await seedBigRoomData(data, 'th_big', ['researcher', 'critic'], { count: 4000 });
    const after = await new Store(data).load();
    assert.equal(after.items('th_big').length, 4000);
    await after.close();
    const note = seeded.note('http://127.0.0.1:4310');
    assert.match(note, /4,000 generated items/);
    assert.doesNotMatch(note, /about 1,000/);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});
