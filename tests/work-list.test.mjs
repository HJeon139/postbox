import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { Ledger } from '../server/ledger.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import { summarize, turnLine } from '../shared/work.mjs';
import { commandLabel, turnRows } from '../shared/work-list.mjs';
import { fakeRepo, ledgerIn } from './fake-repo.mjs';

const ROOT = '/work/uat-project';
const FILES = {
  'converter.py': 'def km_to_mi(k):\n    return k * 0.621\n',
  'test_converter.py': 'from converter import km_to_mi\n',
  'README.md': 'Use km_to_mi.\n',
};

/** Shows an app in the turn, as show_app leaves it in the store. */
function showApp(store, turn, { id = 'units', title = 'Unit converter', version = 1 } = {}) {
  store.emit('app', { id, threadId: 'th_1', title, current: version, versions: [] });
  store.emit('item.add', { threadId: 'th_1', item: { id: `it_${id}`, kind: 'block', turnId: turn.id, valid: true, block: { id, type: 'app', title } } });
}

// A sed’s files under its command (#195’s first acceptance case) moved to #240, which snapshots before the command
// runs. Here a turn of a sed, a quiet commit and an app lists the commit, the app and both commands.
test('a turn lists the commit no gitOperation reported, the app it showed and its commands, in order (#195)', async () => {
  const repo = fakeRepo(ROOT, FILES);
  repo.commit('Converter');
  const { store, turn, run, end, of } = await ledgerIn(repo);
  const rename = (t) => t.replaceAll('km_to_mi', 'kilometres_to_miles');
  await run(`cd "${ROOT}" && sed -i '' 's/km_to_mi/kilometres_to_miles/g' converter.py test_converter.py README.md`, () => {
    for (const f of Object.keys(FILES)) repo.write(f, rename(FILES[f]));
  });
  await run(`cd "${ROOT}" && git add -A && git commit -q -m "Rename km_to_mi"`, () => repo.commit('Rename km_to_mi'));
  showApp(store, turn);
  await end();
  const entries = store.state.work.th_1;
  assert.deepEqual(of('file'), [], 'a command’s files are #240’s');
  assert.equal(of('commit')[0].message, 'Rename km_to_mi');
  assert.deepEqual(
    of('commit')[0]
      .files.map((f) => f.path)
      .sort(),
    ['README.md', 'converter.py', 'test_converter.py'],
    'the commit names the files',
  );
  assert.deepEqual(
    of('publish').map((p) => [p.what, p.title, p.version]),
    [['app', 'Unit converter', 1]],
  );
  const rows = turnRows(entries, turn.id, { folders: [ROOT] });
  assert.deepEqual(
    rows.map((r) => r.kind),
    ['publish', 'commit', 'command', 'command'],
    'what it showed, its commits, and its commands',
  );
  assert.equal(rows.find((r) => r.kind === 'publish').detail, 'v1');
  assert.match(rows.at(-1).label, /^git add -A && git commit/, 'the command without the project folder’s cd');
  assert.equal(turnLine(entries, turn.id), '2 commands · 1 app · 1 commit');
  assert.deepEqual(summarize(entries).idle.list, [], 'the turn left something lasting');
});

test('reads and fetches are one row, last, and a turn that only read still has its list (#195)', async () => {
  const repo = fakeRepo(ROOT, FILES);
  const { ledger, turn, end, of, store } = await ledgerIn(repo);
  const calls = [
    ['Read', { file_path: `${ROOT}/converter.py` }],
    ['Read', { file_path: 'README.md' }],
    ['Grep', { pattern: 'km_to_mi', path: ROOT }],
    ['WebFetch', { url: 'https://example.com/units' }],
    ['WebSearch', { query: 'miles per kilometre' }],
  ];
  calls.forEach(([name, input], i) => {
    ledger.toolUse(turn, { id: `r${i}`, name, input });
  });
  await end();
  assert.deepEqual(
    of('read').map((r) => [r.tool, r.what]),
    [
      ['Read', 'converter.py'],
      ['Read', 'README.md'],
      ['Grep', 'km_to_mi'],
      ['WebFetch', 'https://example.com/units'],
      ['WebSearch', 'miles per kilometre'],
    ],
  );
  const entries = store.state.work.th_1;
  assert.deepEqual(turnRows(entries, turn.id), [{ kind: 'reads', at: 'work-reads', label: 'Read 2 files · fetched 1 page · 2 searches', count: 5 }]);
  assert.equal(turnLine(entries, turn.id), 'Read 2 files · fetched 1 page · 2 searches');
});

test('a command row shows the agent’s description, or the command without the project folder’s cd', () => {
  assert.equal(commandLabel({ command: 'cd /p && ls', description: 'List files' }, ['/p']), 'List files');
  assert.equal(commandLabel({ command: 'cd "/p" && python3 -m unittest' }, ['/p']), 'python3 -m unittest');
  assert.equal(commandLabel({ command: 'cd /other && make' }, ['/p']), 'cd /other && make', 'a cd elsewhere stays');
  assert.equal(commandLabel({ command: 'npm test\necho done' }), 'npm test');
});

test('an app a later turn updates moves on without the list of the turn that showed it, which stays where it was (#195)', async () => {
  const store = new Store(null);
  const ledger = new Ledger({ store, io: fakeRepo('/nowhere').io, git: async () => ({ code: 128, stdout: '', stderr: '' }) });
  const adapter = {
    name: 'mock',
    next: [],
    async deliver(_se, _m, ctx) {
      await this.next.shift()(ctx);
    },
  };
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register(adapter),
    corpus: { search: () => [], read: () => null, stats: () => ({ books: [], passages: 0 }) },
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0 },
    ledger,
  });
  store.emit('project', { id: 'p1', name: 'P', folder: '/proj' });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [rt.createPersona({ handle: 'dev' }).id] });
  const settle = async () => {
    for (let i = 0; i < 100 && rt.turns.size; i++) await new Promise((r) => setTimeout(r, 5));
    await ledger.idle();
    await new Promise((r) => setTimeout(r, 5));
  };
  const code = '<p>1 km is 0.621 mi</p>';
  adapter.next.push(async (c) => {
    c.text('Here it is.');
    c.tools.show_app({ id: 'units', title: 'Unit converter', code });
  });
  rt.sendMessage(t.id, { text: 'Make a converter' });
  await settle();
  adapter.next.push(async (c) => {
    c.tools.update_app({ id: 'units', code: code.replace('0.621', '0.6214') });
    c.text('Updated.');
  });
  rt.sendMessage(t.id, { text: 'More precise' });
  await settle();
  const turns = store.state.work[t.id].filter((e) => e.kind === 'turn').map((e) => e.id);
  const lists = store
    .items(t.id)
    .filter((i) => i.work)
    .map((i) => [i.kind, i.workTurn]);
  assert.deepEqual(lists, [
    ['moved', turns[0]],
    ['agent', turns[1]],
  ]);
});
