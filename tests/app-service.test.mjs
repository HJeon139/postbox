// Apps’ interface (designs/architecture/services.md, “Apps”): agents’ apps, their versions, saved state, host data and
// the browser’s check, blocks shown and updated, and which answers an agent has read, on the Apps rig
// (tests/app-service-fixture.mjs); review comments are tests/app-service-review.test.mjs.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rig } from './app-service-fixture.mjs';

const CODE = '<p>Lab</p>';

/** Shows an app of alpha’s, as show_app does, and returns its item. */
function shown(apps, threads, { id = 'lab', permissions = [], files = [] } = {}) {
  const it = threads.addItem('th_c', {
    kind: 'block',
    valid: true,
    sessionId: 'se_1',
    handle: 'alpha',
    block: { id, type: 'app', version: 1, title: 'Lab', code: CODE },
  });
  apps.register('se_1', { id, title: 'Lab', code: CODE, permissions }, it.id, 'th_c', files);
  return it;
}

/** The tools’ context for a turn of alpha’s, as toolsFor makes it. */
const ctx = (store) => ({ turn: null, se: () => store.state.sessions.se_1, threadId: () => 'th_c', endSegment() {} });

// ── Apps and their check ─────────────────────────────────────────────────────────────

test('a registered app is v1 and pending; a clean check passes it, and an old version’s report is ignored', () => {
  const { store, threads, apps } = rig();
  shown(apps, threads);
  assert.deepEqual([store.state.apps.lab.current, store.state.apps.lab.check.status], [1, 'pending']);
  assert.deepEqual(apps.appCheck('lab', { version: 2, problems: [] }), { ignored: true });
  assert.deepEqual(apps.appCheck('lab', { version: 1, problems: [] }), { status: 'passed' });
  assert.throws(
    () => apps.appCheck('gone', { version: 1 }),
    (e) => e.status === 404,
  );
});

test('a blocking problem goes back to the agent once as a fix turn, through send; the next version’s is a note, and a script error then crashes it', () => {
  const { store, threads, apps, sent, linted } = rig();
  const it = shown(apps, threads);
  const problems = [{ code: 'text-too-small', message: 'Small text.' }];
  assert.deepEqual(apps.appCheck('lab', { version: 1, problems }), { status: 'fixing' });
  assert.deepEqual(sent, [{ sessionId: 'se_1', message: { kind: 'app-check', appId: 'lab', problems }, opts: { threadId: 'th_c' } }]);
  apps.updateApp(
    'se_1',
    null,
    () => 'th_c',
    () => {},
    { id: 'lab', code: '<p>Lab 2</p>' },
  );
  assert.equal(store.state.apps.lab.current, 2);
  assert.deepEqual(apps.appCheck('lab', { version: 2, problems }), { status: 'note' });
  assert.equal(sent.length, 1, 'no second fix turn');
  // The person’s note is plain, so what the fix left reaches the agent in a lint turn, and the note says so (#981).
  assert.deepEqual(
    linted.at(-1)?.problems.map((p) => p.message),
    ['Small text.'],
    'what the fix left goes to the agent',
  );
  assert.equal(store.state.apps.lab.check.told, true);
  apps.updateApp(
    'se_1',
    null,
    () => 'th_c',
    () => {},
    { id: 'lab', code: '<p>Lab 3</p>' },
  );
  assert.deepEqual(apps.appCheck('lab', { version: 3, problems: [{ code: 'script-error', message: 'x is undefined' }] }), { status: 'crashed' });
  assert.equal(store.item('th_c', it.id).block.type, 'app');
});

test('warnings show the app with notes, and the agent hears of them in the lint turn of its running turn, else its last', () => {
  const { threads, running, apps, linted } = rig();
  shown(apps, threads);
  assert.deepEqual(apps.appCheck('lab', { version: 1, problems: [{ code: 'marks-too-small', message: 'Tiny.' }] }), { status: 'note' });
  assert.equal(linted[0].turnId, 'tu_0', 'the last turn that ended');
  assert.deepEqual(linted[0].problems[0].scope, { kind: 'app', id: 'lab', title: 'Lab' });
  shown(apps, threads, { id: 'lab2' });
  running.begin({ id: 'tu_live', sessionId: 'se_1' });
  apps.appCheck('lab2', { version: 1, problems: [{ code: 'marks-too-small', message: 'Tiny.' }] });
  assert.equal(linted[1].turnId, 'tu_live');
});

test('a problem only Postbox’s own check has goes to no agent, and the note doesn’t say the agent was told (#981)', () => {
  const { store, threads, apps, linted, sent } = rig();
  shown(apps, threads);
  assert.deepEqual(apps.appCheck('lab', { version: 1, problems: [{ code: 'check-error', message: 'No matrix.' }] }), { status: 'note' });
  assert.deepEqual([linted.length, sent.length, store.state.apps.lab.check.told], [0, 0, undefined]);
});

// ── What an app sends, saves and reads ───────────────────────────────────────────────

test('appEvent sends each event in the person’s voice, with no limit a minute and nothing held (#1488)', () => {
  const { store, threads, apps, sent } = rig();
  shown(apps, threads);
  const now = 1_000_000;
  for (let i = 0; i < 8; i++) assert.equal(apps.appEvent('lab', 'send', { text: `hi ${i}` }, { now }).ok, true, `send ${i + 1}`);
  assert.equal(sent.length, 8);
  // Sent with the voice line it posted, which its entry points at (#1425).
  const voice = store.items('th_c').find((x) => x.kind === 'voice');
  assert.deepEqual(sent[0].opts, { threadId: 'th_c', itemId: voice.id });
  assert.equal(sent[0].message.kind, 'event');
  assert.equal(store.items('th_c').filter((x) => x.kind === 'voice').length, 8);
});

test('appState saves the app’s state, writes nothing for the same state, and refuses one over 256 KB', () => {
  const { store, threads, apps } = rig();
  shown(apps, threads);
  apps.appState('lab', { n: 1 });
  assert.deepEqual(store.state.apps.lab.state, { n: 1 });
  const before = store.state.apps.lab;
  apps.appState('lab', { n: 1 });
  assert.equal(store.state.apps.lab, before, 'no write');
  assert.throws(
    () => apps.appState('lab', { big: 'x'.repeat(300 * 1024) }),
    (e) => e.status === 413,
  );
});

test('appQuery runs a host tool only when the app asked for it and its agent holds it; every agent holds its room’s assets', async () => {
  const { threads, apps, searched } = rig();
  shown(apps, threads, { permissions: ['assets.search', 'narrate.speak'] });
  assert.deepEqual(await apps.appQuery('lab', 'assets.search', { query: 'q' }), [{ name: 'a.md' }]);
  assert.deepEqual(searched, [['th_c', { query: 'q' }]]);
  assert.throws(
    () => apps.appQuery('lab', 'narrate.speak', {}),
    (e) => e.status === 403,
    'its agent doesn’t hold it',
  );
});

test('appFile reads a version’s data file from the blobs, and is a 404 for a name it doesn’t have or without blobs', async () => {
  const { threads, apps } = rig();
  shown(apps, threads, { files: [{ name: 'data', sha256: 'f1', size: 4 }] });
  assert.equal((await apps.appFile('lab', 'data')).toString(), 'data');
  await assert.rejects(
    () => apps.appFile('lab', 'other'),
    (e) => e.status === 404,
  );
  const none = rig({ blobs: null });
  shown(none.apps, none.threads, { files: [{ name: 'data', sha256: 'f1', size: 4 }] });
  await assert.rejects(
    () => none.apps.appFile('lab', 'data'),
    (e) => e.status === 404,
  );
});

test('appOf is the app an item shows, only on the app’s own item', () => {
  const { threads, apps } = rig();
  const it = shown(apps, threads);
  assert.equal(apps.appOf(it)?.id, 'lab');
  assert.equal(apps.appOf({ ...it, id: 'it_stub' }), null);
});

test('retire signals app.retired with the app as written, after it reads as retired; a new version brings it back', () => {
  const { store, threads, apps, signals } = rig();
  shown(apps, threads);
  assert.equal(apps.retire('se_2', { id: 'lab', reason: 'Done' }).ok, false, 'only the agent that showed it');
  assert.equal(apps.retire('se_1', { id: 'lab', reason: 'Done' }).ok, true);
  assert.equal(signals.length, 1);
  assert.equal(signals[0][0], 'app.retired');
  assert.equal(signals[0][1].app.retired.reason, 'Done');
  assert.equal(store.state.apps.lab.retired.by, 'alpha');
  assert.throws(
    () => apps.appEvent('lab', 'send', { text: 'hi' }),
    (e) => e.status === 409,
  );
  apps.updateApp(
    'se_1',
    null,
    () => 'th_c',
    () => {},
    { id: 'lab', code: '<p>Back</p>' },
  );
  assert.equal(store.state.apps.lab.retired, undefined);
});

// ── Blocks ───────────────────────────────────────────────────────────────────────────

test('showBlock shows a block, and an app as a registered app; updateBlock withdrawing one signals block.withdrawn', () => {
  const { store, apps, signals } = rig();
  const block = {
    id: 'q1',
    type: 'choice',
    version: 1,
    fallback: 'Pick A or B.',
    prompt: 'Pick one',
    options: [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
    ],
  };
  assert.equal(apps.showBlock('se_1', { ...ctx(store), tools: {} }, { block }).ok, true);
  const app = apps.showBlock(
    'se_1',
    { ...ctx(store), tools: {} },
    { block: { id: 'lab', type: 'app', version: 1, title: 'Lab', fallback: 'An app', code: CODE } },
  );
  assert.equal(app.ok, true);
  assert.equal(store.state.apps.lab.current, 1);
  const r = apps.updateBlock('se_1', { block: { id: 'q1', withdraw: 'Not needed any more' } }, ctx(store));
  assert.equal(r.ok, true);
  const it = store.items('th_c').find((x) => x.block?.id === 'q1');
  assert.equal(it.closed.by, 'agent');
  assert.deepEqual(
    signals.map(([s, d]) => [s, d.se.id, d.itemId]),
    [['block.withdrawn', 'se_1', it.id]],
  );
});

test('an answer is read once its event starts a turn; an update over an unread answer is refused, waiting while its event is held', () => {
  const { store, threads, running, apps } = rig();
  const block = {
    id: 'q1',
    type: 'choice',
    version: 1,
    fallback: 'Pick A or B.',
    prompt: 'Pick one',
    options: [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
    ],
  };
  const it = threads.addItem('th_c', {
    kind: 'block',
    valid: true,
    sessionId: 'se_1',
    handle: 'alpha',
    block,
    answered: true,
    answer: { action: 'choose', values: { choice: 'A' }, voice: 'A', at: 0, revision: 1, read: false },
  });
  running.begin({ id: 'tu_1', sessionId: 'se_1', pending: [{ message: { blockItemId: it.id } }] });
  const waiting = apps.updateBlock('se_1', { block: { ...block, prompt: 'Pick again' } }, ctx(store));
  assert.equal(waiting.ok, false);
  assert.match(waiting.message, /reaches you when this turn ends/);
  apps.answerDelivered('th_c', { kind: 'event', blockItemId: it.id, event: { revision: 1 } });
  assert.equal(store.item('th_c', it.id).answer.read, true);
});
