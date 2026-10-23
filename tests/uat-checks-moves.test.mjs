// #213: the checks for #123 and #49 read an item brought to the newest point (item.move, #49, #92, #173), as Postbox
// moves it. Before, a block’s revision that came by item.move went unseen, and an app moved to the newest point was
// measured from the end of the run.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { runChecks } from '../tools/uat/checks.mjs';
import { keepEvent, readHistory } from '../tools/uat/history.mjs';

const T0 = Date.parse('2026-10-23T21:25:00.000Z');
const facts = (over = {}) => ({
  state: {
    threads: { t1: { id: 't1', title: 'SciFact', kind: 'thread', members: ['s1'] } },
    items: { t1: [] },
    sessions: { s1: { id: 's1', handle: 'researcher', state: 'idle' } },
    apps: {},
    glossary: {},
  },
  threads: ['t1'],
  startPersonas: [],
  streams: [],
  transcripts: [],
  console: [],
  apps: {},
  probes: { fullScreen: [], attachments: [], answers: [] },
  samples: [],
  ui: {},
  userMcpServers: [],
  userRulesMarker: null,
  ...over,
});
const found = (f, check) => runChecks(f).filter((x) => x.check === check);

const session = (seq, state) => ({ seq, type: 'session', data: { id: 's1', state, finishedAt: state === 'idle' ? T0 : null } });
const added = {
  seq: 2,
  type: 'item.add',
  data: {
    threadId: 't1',
    item: {
      id: 'it_OC786AUb',
      kind: 'block',
      sessionId: 's1',
      handle: 'researcher',
      valid: true,
      at: T0,
      block: { id: 'explainer-review', type: 'review', title: 'Corrected explainer' },
    },
  },
};
// What bringForward emits for update_block on a block that follows the conversation: the stub, and the update as a patch.
const moved = (seq, revision, at) => ({
  seq,
  type: 'item.move',
  data: {
    threadId: 't1',
    id: 'it_OC786AUb',
    stub: { id: `it_stub${seq}`, kind: 'moved', at, itemId: 'it_OC786AUb', what: 'block', title: 'Corrected explainer (v2)' },
    patch: {
      block: { id: 'explainer-review', type: 'review', title: 'Corrected explainer (v2)' },
      answered: false,
      answer: null,
      revision,
      updatedAt: at,
      at,
      movedAt: at,
    },
  },
});
const answer = (seq, action, at) => ({
  seq,
  type: 'item.patch',
  data: { threadId: 't1', id: 'it_OC786AUb', patch: { answered: true, answer: { action, values: {}, at } } },
});

describe('approval-for-other-revision follows a block that moved (#123, #213)', () => {
  test('an answer to the revision that came by item.move is applied to that revision: no finding', () => {
    // scifact at 7fa3a6d: the runner read revision 2 and submitted it, and the check said Postbox applied it to revision 1.
    const events = [session(1, 'think'), added, moved(3, 2, T0 + 60_000), session(4, 'idle'), answer(5, 'submit', T0 + 90_000)];
    const probes = { fullScreen: [], attachments: [], answers: [{ key: 'it_OC786AUb', revision: 2, at: T0 + 89_000 }] };
    assert.deepEqual(found(facts({ events, probes }), 'approval-for-other-revision'), []);
    // An answer to revision 1 that landed on the moved revision 2 is still the defect.
    const stale = { ...probes, answers: [{ key: 'it_OC786AUb', revision: 1, at: T0 + 89_000 }] };
    const [hit] = found(facts({ events, probes: stale }), 'approval-for-other-revision');
    assert.equal(hit?.evidence, 'The person answered revision 1 of @researcher’s “Corrected explainer”, and Postbox applied their submit to revision 2.');
  });

  test('a real unread reopening by item.move still fires', () => {
    // The person asked for changes while @researcher worked, and its update in the same turn moved the block, reopened.
    const events = [session(1, 'think'), added, answer(3, 'request_changes', T0 + 5000), moved(4, 2, T0 + 9000)];
    const hits = found(facts({ events }), 'approval-for-other-revision');
    assert.deepEqual(
      hits.map((h) => [h.key, h.evidence]),
      [
        [
          'reopened:it_OC786AUb:2',
          '@researcher’s update made revision 2 of “Corrected explainer” 4 s after the person’s request_changes on revision 1, with no turn in between to read it, so the answer was erased unread.',
        ],
      ],
    );
    // Read first (a turn started after the answer): quiet.
    const read = [session(1, 'idle'), added, answer(3, 'request_changes', T0 + 5000), session(4, 'think'), moved(5, 2, T0 + 9000)];
    assert.deepEqual(found(facts({ events: read }), 'approval-for-other-revision'), []);
  });

  test('the history keeps item.move, and a run saved without it takes its moves from Postbox’s own log', () => {
    assert.equal(keepEvent(3, 'item.move', moved(3, 2, T0).data)?.type, 'item.move');
    const dir = mkdtempSync(join(tmpdir(), 'uat-moves-'));
    try {
      mkdirSync(join(dir, 'data'));
      // events.jsonl as runners before #213 saved it: no item.move.
      writeFileSync(
        join(dir, 'events.jsonl'),
        [session(1, 'think'), added, session(4, 'idle'), answer(5, 'submit', T0 + 90_000)].map((e) => JSON.stringify(e)).join('\n'),
      );
      writeFileSync(join(dir, 'data', 'events-1.jsonl'), [added, moved(3, 2, T0 + 60_000)].map((e) => JSON.stringify(e)).join('\n'));
      assert.deepEqual(
        readHistory(dir).map((e) => `${e.seq} ${e.type}`),
        ['1 session', '2 item.add', '3 item.move', '4 session', '5 item.patch'],
      );
      // A history that has its moves is read as it is.
      writeFileSync(join(dir, 'events.jsonl'), JSON.stringify(moved(3, 2, T0)));
      assert.deepEqual(
        readHistory(dir).map((e) => e.seq),
        [3],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('updated-app-far-up measures from the app’s last version (#49, #213)', () => {
  const msg = (i, at) => ({ id: `m${i}`, kind: 'agent', handle: 'researcher', text: `message ${i}`, at });
  const app = (versions) => ({ id: 'scifact-explorer', title: 'SciFact explorer', threadId: 't1', itemId: 'it_app', current: versions.length, versions });
  const appItem = (at, movedAt) => ({
    id: 'it_app',
    kind: 'block',
    valid: true,
    at,
    ...(movedAt ? { movedAt } : {}),
    block: { id: 'scifact-explorer', type: 'app' },
  });
  const run = (items, versions) =>
    found(facts({ state: { ...facts().state, items: { t1: items }, apps: { 'scifact-explorer': app(versions) } } }), 'updated-app-far-up');
  const v = (...ats) => ats.map((at, i) => ({ v: i + 1, at }));

  test('an app brought to the newest point by its update, with later messages under it, is no finding', () => {
    // scifact at 7fa3a6d: v2 moved the app to the newest point (item.move), and seven messages came after it.
    const items = [msg(0, T0), { id: 'stub', kind: 'moved', at: T0 + 60_000, itemId: 'it_app' }, appItem(T0 + 60_000, T0 + 60_000)];
    for (let i = 1; i <= 7; i++) items.push(msg(i, T0 + 60_000 + i * 1000));
    assert.deepEqual(run(items, v(T0, T0 + 60_000)), []);
  });

  test('an app its last version didn’t move, with anything from before that version under it, fires', () => {
    const items = [appItem(T0)];
    for (let i = 1; i <= 8; i++) items.push(msg(i, T0 + i * 1000));
    const [hit] = run(items, v(T0, T0 + 6500));
    assert.equal(hit?.evidence, '“SciFact explorer” is v2, 6 messages up when that version landed, and that version didn’t move it.');
    assert.equal(hit?.issue, 49);
    // scifact on 22 October (5 under it) and at the wave 4 integration (2): main caught these, and they’re still caught.
    assert.equal(run(items, v(T0, T0 + 5500)).length, 1);
    assert.equal(
      run(items, v(T0, T0 + 2500))[0]?.evidence,
      '“SciFact explorer” is v2, 2 messages up when that version landed, and that version didn’t move it.',
    );
    // Nothing under it when it landed: it was already the newest.
    assert.deepEqual(run(items, v(T0, T0 + 500)), []);
    // Moved by v2, and then v3 landed without moving it.
    const moved = [{ id: 'stub', kind: 'moved', at: T0, itemId: 'it_app' }, appItem(T0, T0), ...items.slice(1)];
    assert.equal(run(moved, v(T0 - 9000, T0, T0 + 3500)).length, 1);
    // A version with no time counts every item after the app, as the check did before.
    assert.equal(run(items, [{ v: 1 }, { v: 2 }]).length, 1);
  });
});
