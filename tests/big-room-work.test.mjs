// The big room’s work, opt in (#305, designs/305-archive-turns.md, “Context: what the state holds today”): with
// `work: true`, each agent reply is the last reply of a turn of its agent, and the seed writes that turn’s work entries
// and the reply’s steps in the shapes the ledger and the runtime write, in the proportions of the 1 November run. Off,
// the room is the one every scenario and bench already seeds.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../server/store.mjs';
import { summarize } from '../shared/work.mjs';
import { bigRoomItems, seedBigRoom } from '../tools/uat/big-room.mjs';

const THREAD = 'th_big';

/** A memory store with the room seeded, and what it holds. @param {any} [opts] */
function seeded(opts) {
  const store = new Store(null);
  store.emit('thread', { id: THREAD, kind: 'room', title: 'The release, in a long room', members: [] });
  seedBigRoom(store, THREAD, opts, { researcher: { sessionId: 'se_r' }, critic: { sessionId: 'se_c' }, developer: { sessionId: 'se_d' } });
  return { items: store.state.items[THREAD], work: store.state.work?.[THREAD] ?? [] };
}

const room = seeded({ work: true });
const replies = room.items.filter((it) => it.kind === 'agent');
const turns = room.work.filter((e) => e.kind === 'turn');
const ofKind = (kind) => room.work.filter((e) => e.kind === kind);
const bytes = (v) => Buffer.byteLength(JSON.stringify(v));
/** Each turn’s entries, by its id. */
const byTurn = new Map();
for (const e of room.work) if (e.turnId) byTurn.set(e.turnId, [...(byTurn.get(e.turnId) ?? []), e]);

test('with work on, every agent reply is the last reply of a turn of its agent, with steps', () => {
  assert.ok(replies.length > 500, `${replies.length} replies`);
  assert.equal(turns.length, replies.length);
  for (const it of replies) {
    const t = turns.find((e) => e.turnId === it.turnId);
    assert.ok(t, `${it.id} has a turn entry`);
    assert.equal(t.handle, it.handle);
    assert.equal(t.status, 'done');
    assert.ok(t.startedAt < it.at && t.endedAt <= it.at, `${it.id}’s turn ends by its reply`);
    assert.ok(Array.isArray(it.activity?.steps) && it.activity.steps.length > 0, `${it.id} has steps`);
    assert.ok(new Set(it.activity.steps.map((s) => s.id)).size === it.activity.steps.length, `${it.id}’s step ids are its own`);
  }
  assert.equal(new Set(replies.map((it) => it.turnId)).size, replies.length, 'one turn a reply');
});

test('each entry is its agent’s session’s, in its turn’s thread, and every turn id names a seeded turn', () => {
  const ids = new Set(turns.map((t) => t.turnId));
  const sessions = { researcher: 'se_r', critic: 'se_c', developer: 'se_d' };
  assert.ok(room.work.length > turns.length, `${room.work.length} entries`);
  for (const e of room.work) {
    if (e.kind === 'file') continue; // a file is the conversation’s, as the ledger keeps it, with the turns that changed it
    assert.ok(ids.has(e.turnId), `${e.id} names a seeded turn`);
    assert.equal(e.threadId, THREAD);
    assert.equal(e.sessionId, sessions[e.handle], `${e.id} is ${e.handle}’s session’s`);
  }
  assert.equal(new Set(room.work.map((e) => e.id)).size, room.work.length, 'entry ids are unique in the conversation');
});

test('the room has about 7 work entries a turn, about 70% of them commands, as the 1 November run did', () => {
  const perTurn = room.work.length / turns.length;
  const share = ofKind('command').length / room.work.length;
  assert.ok(perTurn >= 6.5 && perTurn <= 7.5, `${perTurn.toFixed(2)} entries a turn`);
  assert.ok(share >= 0.67 && share <= 0.74, `${(100 * share).toFixed(1)}% commands`);
  // Most of the rest: a file read or changed in about two turns of five.
  for (const kind of ['read', 'change']) {
    const per = ofKind(kind).length / turns.length;
    assert.ok(per >= 0.3 && per <= 0.5, `${per.toFixed(2)} ${kind} entries a turn`);
  }
});

test('turn sizes are skewed: the median turn’s work is under 1 KB, and the largest is over 100 KB', () => {
  const sizes = [...byTurn.values()].map(bytes).sort((a, b) => a - b);
  const median = sizes[Math.floor(sizes.length / 2)];
  assert.ok(median < 1024, `median ${median} bytes`);
  assert.ok(sizes.at(-1) > 100 * 1024, `largest ${sizes.at(-1)} bytes`);
});

test('a command weighs about what the 1 November run’s did, and a few turns in a hundred are the very large ones', () => {
  const commands = ofKind('command');
  const line = commands.reduce((n, e) => n + e.command.length, 0) / commands.length;
  const rest = commands.reduce((n, e) => n + bytes({ ...e, command: undefined }), 0) / commands.length;
  assert.ok(line >= 600 && line <= 1000, `a command line is ${line.toFixed(0)} characters on average`);
  assert.ok(rest >= 380 && rest <= 480, `a command without its line is ${rest.toFixed(0)} bytes on average`);
  const large = [...byTurn.values()].filter((list) => bytes(list) > 100 * 1024).length;
  assert.ok(large >= turns.length / 150 && large <= turns.length / 60, `${large} turns over 100 KB of ${turns.length}`);
});

test('a reply has about 14 steps of about 300 bytes, as the 1 November run’s did', () => {
  const steps = replies.reduce((n, it) => n + it.activity.steps.length, 0);
  const perReply = steps / replies.length;
  const perStep = replies.reduce((n, it) => n + bytes(it.activity), 0) / steps;
  assert.ok(perReply >= 13 && perReply <= 15, `${perReply.toFixed(1)} steps a reply`);
  assert.ok(perStep >= 250 && perStep <= 350, `${perStep.toFixed(0)} bytes a step`);
});

test('about one turn in 20 makes a branch, a commit, a push and a pull request through gh', () => {
  const ships = Math.round(turns.length / 20);
  assert.ok(ships > 10, `${turns.length} turns`);
  for (const kind of ['branch', 'commit', 'push'])
    assert.ok(Math.abs(ofKind(kind).length - ships) <= 1, `${ofKind(kind).length} ${kind} entries for ${turns.length} turns`);
  const prs = ofKind('external');
  assert.ok(Math.abs(prs.length - ships) <= 1, `${prs.length} external entries`);
  for (const e of prs) {
    assert.equal(e.what, 'gh pr create');
    assert.equal(e.via, 'gh');
    assert.equal(e.state, 'done');
    assert.match(e.urls[0], /\/pull\/\d+$/);
    assert.ok(
      ofKind('command').some((c) => c.id === e.commandId && /^gh pr create\b/.test(c.command)),
      `${e.id} names its gh command`,
    );
  }
});

test('a few turns hold an entry left unknown or in the background, I4’s open states, and little of the work', () => {
  const open = (state) =>
    new Set(
      ofKind('command')
        .filter((e) => e.state === state)
        .map((e) => e.turnId),
    );
  const unknown = open('unknown');
  const background = open('background');
  assert.ok(unknown.size >= 3 && background.size >= 3, `${unknown.size} unknown, ${background.size} background`);
  assert.ok(unknown.size + background.size <= turns.length / 8, 'a few turns, not most');
  const held = [...new Set([...unknown, ...background])].reduce((n, id) => n + bytes(byTurn.get(id)), 0);
  const share = held / bytes(room.work);
  assert.ok(share > 0.01 && share < 0.1, `open turns hold ${(100 * share).toFixed(1)}% of the work`);
  for (const e of ofKind('command').filter((c) => c.state === 'background')) assert.equal(e.keptRunning, true);
});

test('the Work view’s summary reads the seeded entries as the ledger’s', () => {
  const s = summarize(room.work);
  assert.equal(s.turns.length, turns.length);
  assert.equal(s.commands.length, ofKind('command').length);
  assert.ok(s.files.length > 0 && s.commits.length > 0);
});

test('the same seed gives the same state, byte for byte', () => {
  const again = seeded({ work: true });
  assert.equal(JSON.stringify(again.work), JSON.stringify(room.work));
  assert.equal(JSON.stringify(again.items), JSON.stringify(room.items));
});

test('with work off, the room’s items are exactly the ones it seeded before, and it writes no work', () => {
  const off = seeded();
  const sessions = { researcher: 'se_r', critic: 'se_c', developer: 'se_d' };
  const before = bigRoomItems().items.map((it) => (it.handle ? { ...it, sessionId: sessions[it.handle] } : it));
  assert.equal(JSON.stringify(off.items), JSON.stringify(before));
  assert.deepEqual(off.work, []);
  assert.ok(off.items.every((it) => !it.turnId && !it.activity));
  const bare = room.items.map(({ turnId, activity, ...it }) => it);
  assert.equal(JSON.stringify(bare), JSON.stringify(off.items), 'work adds a reply’s turn and steps, and changes nothing else');
});
