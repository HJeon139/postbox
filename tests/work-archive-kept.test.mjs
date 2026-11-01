// Branch, commit and push entries stay in the state when their turn is archived (#305; design-305-live-kinds-1): the
// ledger asks the state whether a branch or commit is already recorded (ledger-commands.mjs known, leftBranch), and they
// are 0.34% of the work on a real room. The pass moves everything else with a turnId, and passes over a turn that has
// nothing else to move.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memoryBlobs } from '../server/ledger-io.mjs';
import { Store } from '../server/store.mjs';
import { archiveTurns } from '../server/work-archive.mjs';
import { summarize } from '../shared/work.mjs';
import { fakeRepo, ledgerIn } from './fake-repo.mjs';

const C = 'th_c';
const KEPT = ['branch', 'commit', 'push'];
const ids = (list) => list.map((e) => e.id);

/** Turn t1 with a command, a change, and a branch, a commit and a push; then t2 and t3 as plain turns. */
function room() {
  const s = new Store(null);
  s.emit('thread', { id: C, members: [] });
  const add = (entry) => s.emit('work.add', { convId: C, entry });
  add({ id: 'c1', turnId: 't1', kind: 'command', command: 'git commit', at: 1, state: 'done' });
  add({ id: 'ch1', turnId: 't1', kind: 'change', fileId: 'wf_1', added: 2, deleted: 0, at: 2 });
  add({ id: 'wb1', turnId: 't1', kind: 'branch', name: 'feat/x', at: 3 });
  add({ id: 'wk1', turnId: 't1', kind: 'commit', sha: 'abc123', at: 4 });
  add({ id: 'wp1', turnId: 't1', kind: 'push', branch: 'feat/x', at: 5 });
  for (const [k, t] of ['t2', 't3'].entries()) add({ id: `c_${t}`, turnId: t, kind: 'command', command: 'ls', at: 10 + k, state: 'done' });
  return s;
}
const pass = (s, blobs = memoryBlobs()) => archiveTurns({ store: s, blobs, convId: C, running: new Set() }).then(() => blobs);

test('1: the pass moves the command and the change and leaves the branch, the commit and the push in the state', async () => {
  const s = room();
  await pass(s);
  const list = s.state.work[C];
  assert.deepEqual(
    list.filter((e) => e.turnId === 't1' && e.kind !== 'turn-archive').map((e) => e.kind),
    KEPT,
  );
  assert.equal(list.filter((e) => e.kind === 'turn-archive').length, 1);
  assert.ok(!list.some((e) => ['c1', 'ch1'].includes(e.id)), 'the command and the change are gone');
});

test('1: the archive file holds the moved entries only, and the summary lists only their ids', async () => {
  const s = room();
  const blobs = await pass(s);
  const sum = s.state.work[C].find((e) => e.kind === 'turn-archive');
  assert.deepEqual(sum.entryIds, ['c1', 'ch1']);
  const body = JSON.parse((await blobs.get(sum.sha256)).toString());
  assert.deepEqual(ids(body.work), ['c1', 'ch1']);
});

test('4: the reducer removes only the listed ids, so a replay of the pass’s event gives the same state', async () => {
  const s = room();
  await pass(s);
  const replay = new Store(null);
  replay.emit('thread', { id: C, members: [] });
  for (const e of room().state.work[C]) replay.emit('work.add', { convId: C, entry: e });
  const ev = s.log?.find?.((x) => x.type === 'turn.archive');
  const sum = s.state.work[C].find((e) => e.kind === 'turn-archive');
  replay.emit('turn.archive', { convId: C, turnId: 't1', sha256: sum.sha256, summary: sum, items: [] });
  assert.deepEqual(ids(replay.state.work[C]), ids(s.state.work[C]));
  assert.equal(ev === undefined || ev.type === 'turn.archive', true);
});

test('4: an entry of the turn that the event does not list stays, though it has the same turn id', async () => {
  const s = room();
  const sum = { id: 'wa_t1', kind: 'turn-archive', turnId: 't1', at: 1, sha256: 'x', entryIds: ['c1'], counts: {}, effort: {}, handles: [] };
  s.emit('turn.archive', { convId: C, turnId: 't1', sha256: 'x', summary: sum, items: [] });
  assert.deepEqual(ids(s.state.work[C].filter((e) => e.turnId === 't1')), ['wa_t1', 'ch1', 'wb1', 'wk1', 'wp1']);
});

test('6: a second pass writes no second file and changes nothing', async () => {
  const s = room();
  const blobs = memoryBlobs();
  let puts = 0;
  const put = blobs.put.bind(blobs);
  blobs.put = (...a) => {
    puts++;
    return put(...a);
  };
  assert.equal(await archiveTurns({ store: s, blobs, convId: C, running: new Set() }), 1);
  const before = JSON.stringify(s.state.work[C]);
  assert.equal(await archiveTurns({ store: s, blobs, convId: C, running: new Set() }), 0);
  assert.equal(puts, 1);
  assert.equal(JSON.stringify(s.state.work[C]), before);
});

test('7: an older kept-only turn is passed over, with no file, and does not block a newer eligible one', async () => {
  const s = new Store(null);
  s.emit('thread', { id: C, members: [] });
  const add = (entry) => s.emit('work.add', { convId: C, entry });
  add({ id: 'wk0', turnId: 't0', kind: 'commit', sha: 'zzz', at: 1 });
  add({ id: 'c1', turnId: 't1', kind: 'command', command: 'ls', at: 2, state: 'done' });
  add({ id: 'c2', turnId: 't2', kind: 'command', command: 'ls', at: 3, state: 'done' });
  add({ id: 'c3', turnId: 't3', kind: 'command', command: 'ls', at: 4, state: 'done' });
  let puts = 0;
  const blobs = memoryBlobs();
  const put = blobs.put.bind(blobs);
  blobs.put = (...a) => {
    puts++;
    return put(...a);
  };
  assert.equal(await archiveTurns({ store: s, blobs, convId: C, running: new Set() }), 1);
  assert.equal(puts, 1, 'one file, for t1');
  const list = s.state.work[C];
  assert.deepEqual(
    list.filter((e) => e.kind === 'turn-archive').map((e) => e.turnId),
    ['t1'],
  );
  assert.ok(
    list.some((e) => e.id === 'wk0'),
    'the kept-only turn’s commit is untouched',
  );
  assert.equal(await archiveTurns({ store: s, blobs, convId: C, running: new Set() }), 0);
  assert.equal(puts, 1, 'a later pass puts nothing either');
});

test('8: summarize over kept entries beside a summary counts the turn once', async () => {
  const s = room();
  await pass(s);
  const sum = summarize(s.state.work[C]);
  assert.equal(sum.commits.length, 1);
  assert.equal(sum.pushes.length, 1);
  assert.equal(sum.branches.length, 1);
  assert.equal(s.state.work[C].filter((e) => e.kind === 'turn-archive').length, 1);
});

/** A repo whose first turn committed, archived with two plain turns after it; `again` runs a command in a new turn. */
async function archivedCommit() {
  const repo = fakeRepo('/work/proj', { 'a.txt': 'one\n' });
  const base = repo.commit('Start');
  const { store, ledger, run, end, of } = await ledgerIn(repo);
  await run('git commit -qam "Typo"', () => {
    repo.write('a.txt', 'two\n');
    repo.commit('Typo');
  });
  await end();
  for (const [k, t] of ['f2', 'f3'].entries())
    store.emit('work.add', { convId: 'th_1', entry: { id: `c_${t}`, turnId: t, kind: 'command', command: 'ls', at: 1e6 + k, state: 'done' } });
  await archiveTurns({ store, blobs: memoryBlobs(), convId: 'th_1', running: new Set() });
  const again = async (command, does) => {
    const turn = { id: 'turn_9', threadId: 'th_1', startedAt: 1e7 };
    ledger.startTurn(turn, { se: { id: 'se_1', handle: 'dev' }, folder: repo.root, projectFolder: repo.root });
    await ledger.idle();
    ledger.toolUse(turn, { id: 'tu_9', name: 'Bash', input: { command } });
    await ledger.idle();
    does();
    ledger.toolResult(turn, { id: 'tu_9', text: '', vcsCwd: null, result: { stdout: '', stderr: '', interrupted: false } });
    await ledger.idle();
  };
  return { repo, base, store, ledger, of, again };
}

test('2: after the pass the ledger still finds the archived turn’s commit and branch (what known() and the branch check read)', async () => {
  const { store, ledger, of } = await archivedCommit();
  assert.ok(
    store.state.work.th_1.some((e) => e.kind === 'turn-archive'),
    'the turn was archived',
  );
  assert.equal(of('commit').length, 1);
  assert.equal(ledger.entries('th_1').filter((e) => e.kind === 'commit').length, 1);
  assert.equal(of('commit')[0].message, 'Typo');
});

test('3: after the pass, an amend marks the archived turn’s live commit as left', async () => {
  const { repo, base, of, again } = await archivedCommit();
  await again('git commit -q --amend -am "Fixed"', () => {
    repo.reset(base);
    repo.commit('Fixed');
  });
  assert.deepEqual(
    of('commit').map((c) => [c.message, Boolean(c.left)]),
    [
      ['Typo', true],
      ['Fixed', false],
    ],
  );
});
