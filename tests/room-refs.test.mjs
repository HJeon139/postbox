// #1446: what a message names that Work’s viewer opens (shared/room-refs.mjs): an asset by id or name, in the
// conversation’s own room only, and a changed file by its path or a file name only one changed file has.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { conversationOf, refLookup, relevantRefs, roomAsset, roomAssets } from '../shared/room-refs.mjs';
import { apply, emptyState } from '../shared/state.mjs';

const version = (v, over = {}) => ({
  v,
  sha256: String(v).repeat(64),
  size: 1,
  type: 'text/markdown',
  isText: true,
  author: 'dev',
  at: v * 10,
  base: null,
  ...over,
});

function room() {
  const s = emptyState();
  apply(s, 'thread', { id: 'th_a', members: [] });
  apply(s, 'thread', { id: 'th_a_topic', kind: 'topic', parentId: 'th_a', members: [] });
  apply(s, 'thread', { id: 'th_b', members: [] });
  const put = (id, room, name, at) => {
    apply(s, 'asset', { id, room, name, created: at });
    apply(s, 'asset.version', { id, version: version(1, { at }), prunes: [], released: [] });
  };
  put('as_Plan0001', 'th_a', 'notes/Plan.md', 10);
  put('as_Data0002', 'th_a', 'data.csv', 20);
  put('as_Their003', 'th_b', 'theirs.md', 30);
  const file = (id, rel) => apply(s, 'work.add', { convId: 'th_a', entry: { id, kind: 'file', path: `/p/${rel}`, rel } });
  file('wf_cite', 'src/cite.mjs');
  file('wf_readme1', 'README.md');
  file('wf_readme2', 'docs/README.md');
  file('wf_util1', 'a/util.mjs');
  file('wf_util2', 'b/util.mjs');
  return s;
}

test('a topic thread’s conversation is the one it hangs from', () => {
  const s = room();
  assert.equal(conversationOf(s.threads, 'th_a_topic'), 'th_a');
  assert.equal(conversationOf(s.threads, 'th_a'), 'th_a');
});

test('an asset id names the asset only in its own conversation', () => {
  const s = room();
  const find = refLookup(s, 'th_a');
  assert.deepEqual(find('as_Plan0001'), { at: 'as_Plan0001', kind: 'asset' });
  assert.equal(find('as_Their003'), null, 'another room’s asset');
  assert.equal(find('as_Nothere9'), null);
});

test('an asset’s name names it, ignoring case', () => {
  assert.deepEqual(refLookup(room(), 'th_a')('notes/plan.md'), { at: 'as_Plan0001', kind: 'asset' });
});

test('a changed file goes by its path in the project, its full path, or a file name only it has', () => {
  const find = refLookup(room(), 'th_a');
  for (const t of ['src/cite.mjs', '/p/src/cite.mjs', 'cite.mjs', ' cite.mjs ']) assert.deepEqual(find(t), { at: 'wf_cite', kind: 'file' }, t);
});

test('a file name two changed files share names neither, but each one’s exact path still does', () => {
  const find = refLookup(room(), 'th_a');
  assert.equal(find('README.md')?.at, 'wf_readme1', 'the exact path of the one at the top');
  assert.equal(find('util.mjs'), null, 'a/util.mjs and b/util.mjs');
  assert.deepEqual(find('docs/README.md'), { at: 'wf_readme2', kind: 'file' });
  assert.equal(refLookup(room(), 'th_a')('index.mjs'), null);
});

test('a deleted asset isn’t opened, and the list skips it', () => {
  const s = room();
  apply(s, 'asset.version', { id: 'as_Data0002', version: version(2, { sha256: null, at: 40 }), prunes: [], released: [] });
  assert.equal(roomAsset(s, 'th_a', 'as_Data0002'), null);
  assert.deepEqual(
    roomAssets(s, 'th_a').map((a) => a.id),
    ['as_Plan0001'],
  );
});

test('the room’s assets come newest first', () => {
  assert.deepEqual(
    roomAssets(room(), 'th_a_topic').map((a) => a.id),
    ['as_Data0002', 'as_Plan0001'],
  );
});

// #1446’s second part: what the chat is about now, for the pane’s In this chat.
const said = (at, text, kind = 'agent') => ({ id: `it_${at}`, kind, text, at, status: 'done' });

test('what the latest messages name ranks first, newest first, with each item once', () => {
  const s = room();
  const items = [said(100, 'see `notes/plan.md`'), said(200, 'and `cite.mjs`, then as_Data0002', 'user'), said(300, 'back to `notes/plan.md`')];
  assert.deepEqual(
    relevantRefs(s, 'th_a', items).map((r) => [r.at, r.when]),
    [
      ['as_Plan0001', 300],
      ['wf_cite', 200],
      ['as_Data0002', 200],
    ],
  );
});

test('only the last ten messages count, and only the person’s and the agents’', () => {
  const s = room();
  const items = [
    said(1, '`notes/plan.md`'),
    ...Array.from({ length: 10 }, (_, i) => said(10 + i, 'nothing here')),
    { id: 'x', kind: 'system', text: '`cite.mjs`', at: 99 },
  ];
  assert.deepEqual(relevantRefs(s, 'th_a', items), []);
});

test('files changed and assets written in the last two turns count as touched', () => {
  const s = room();
  const turn = (id, startedAt) => apply(s, 'work.add', { convId: 'th_a', entry: { id, kind: 'turn', startedAt } });
  turn('wt_1', 5);
  apply(s, 'work.add', { convId: 'th_a', entry: { id: 'wc_old', kind: 'change', fileId: 'wf_readme1', turnId: 'wt_1', at: 6 } });
  turn('wt_2', 15);
  turn('wt_3', 25);
  apply(s, 'work.add', { convId: 'th_a', entry: { id: 'wc_new', kind: 'change', fileId: 'wf_cite', turnId: 'wt_3', at: 26 } });
  assert.deepEqual(
    relevantRefs(s, 'th_a', []).map((r) => r.at),
    ['wf_cite', 'as_Data0002'],
    'the third turn’s file, and the asset written at 20, after the second turn began; not the first turn’s file or the asset from 10',
  );
});
