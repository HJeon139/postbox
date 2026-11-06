// The switch bench (#508, tools/bench-switch.mjs): its options, the command and commit its report shows, where each
// switch lands, the proof each run gives that it timed the long room, and what a size leaves behind when its Postbox
// doesn’t start.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  askId,
  BENCH_ROOT,
  commandLine,
  expectedRooms,
  formatReport,
  IDS,
  lastIdOf,
  measureSize,
  NEEDS_SWITCH,
  openAsk,
  options,
  proveCounts,
  provenance,
  proveRun,
  SWITCHES,
  shortItems,
  switchesFor,
} from '../tools/bench-switch.mjs';

const ROOT = '/local/home/user/postbox';

test('the options default to three sizes, five runs a switch, and the bench’s own Postbox', () => {
  const o = options([]);
  assert.deepEqual([o.sizes, o.runs, o.app, o.trace], [[1000, 4000, 10000], 5, null, null]);
});

test('a numeric option that isn’t a positive whole number is refused, naming the option and the value', () => {
  for (const name of ['runs', 'sizes'])
    for (const raw of ['0', '-5', '2.5', 'abc', '', '1e3'])
      assert.throws(() => options([`--${name}=${raw}`]), new RegExp(`^Error: --${name} takes a whole number of at least 1, not “${raw}”\\.$`));
});

test('the report’s command spells out every option, with --out and --app relative or as a name, never absolute', () => {
  const app = mkdtempSync(join(tmpdir(), 'pb-bench-app-'));
  try {
    mkdirSync(join(app, 'server'));
    writeFileSync(join(app, 'server', 'index.mjs'), '');
    const shown = commandLine(options(['--sizes', '200,800', '--runs', '2', '--app', app, '--out', `${ROOT}/designs/508/switch.md`]), ROOT);
    assert.match(shown, /^node tools\/bench-switch\.mjs --sizes 200,800 --runs 2 --app pb-bench-app-\w+ --out designs\/508\/switch\.md$/);
    assert.doesNotMatch(shown, /\/local|~/);
    assert.doesNotMatch(commandLine(options([]), ROOT), /--app/);
  } finally {
    rmSync(app, { recursive: true, force: true });
  }
});

test('--app that isn’t a Postbox checkout is refused', () => {
  const empty = mkdtempSync(join(tmpdir(), 'pb-bench-app-'));
  try {
    assert.throws(() => options(['--app', empty]), /^Error: --app takes a Postbox checkout/);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test('the provenance names --app’s commit beside the bench’s, and the bench’s alone without it', () => {
  const app = mkdtempSync(join(tmpdir(), 'pb-bench-app-'));
  try {
    mkdirSync(join(app, 'server'));
    writeFileSync(join(app, 'server', 'index.mjs'), '');
    const commit = (root) => (root === app ? 'aaaa1111' : 'bbbb2222');
    assert.equal(provenance(options(['--app', app]), commit).commit, 'aaaa1111 (Postbox measured); bbbb2222 (the bench and its seed)');
    assert.equal(provenance(options([]), commit).commit, 'bbbb2222');
    assert.match(provenance(options([]), commit).command, /^node tools\/bench-switch\.mjs /);
  } finally {
    rmSync(app, { recursive: true, force: true });
  }
});

test('both switches land on the long room, from a short conversation: the project switch from the other project', () => {
  const byName = Object.fromEntries(SWITCHES.map((s) => [s.name, s]));
  assert.deepEqual(Object.keys(byName), ['project', 'conversation']);
  for (const s of SWITCHES) {
    assert.equal(s.to, IDS.long, `${s.name} switch’s target`);
    assert.notEqual(s.from, IDS.long);
  }
  assert.equal(byName.project.from, IDS.shortA);
  assert.equal(byName.conversation.from, IDS.shortB);
});

test('the short conversations hold about 20 items, with ids of their own', () => {
  const items = shortItems(IDS.shortB, ['critic'], Date.UTC(2026, 7, 1));
  assert.equal(items.length, 20);
  assert.equal(new Set(items.map((it) => it.id)).size, 20);
  for (const it of items) assert.doesNotMatch(it.id, /^it_big/);
});

const LONG = { thread: IDS.long, count: 1000, last: 'it_big0999' };
const good = { thread: IDS.long, keys: 1000, last: 'it_big0999', composer: 'x', composerThread: IDS.long };

test('a run that timed the long room, with every seeded item and the key in its composer, is proved', () => {
  assert.doesNotThrow(() => proveRun(good, LONG));
});

test('a run that timed the wrong conversation, a short room, or a transcript missing its last item fails loudly', () => {
  assert.throws(() => proveRun({ ...good, thread: IDS.shortB, keys: 20, last: 'it_sw_shortb_19' }, LONG), /timed th_sw_short_b, not the long room th_sw_long/);
  assert.throws(() => proveRun({ ...good, keys: 999 }, LONG), /999 items drawn, not the 1,000 seeded/);
  assert.throws(() => proveRun({ ...good, last: 'it_big0998' }, LONG), /last item drawn is it_big0998, not it_big0999/);
  assert.throws(() => proveRun({ ...good, composer: '' }, LONG), /The key typed after the switch isn’t in the long room’s composer/);
  assert.throws(() => proveRun({ ...good, composerThread: IDS.shortB }, LONG), /The key typed after the switch isn’t in the long room’s composer/);
});

test('a size whose Postbox doesn’t start leaves no data folder behind', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'pb-bench-test-'));
  try {
    const start = async () => {
      throw new Error('Postbox didn’t start: refused');
    };
    await assert.rejects(
      measureSize(null, 200, options(['--sizes', '200']), () => {}, { start, port: async () => 1, tmp }),
      /Postbox didn’t start: refused/,
    );
    assert.deepEqual(readdirSync(tmp), []);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('a size starts the Postbox of --app, and of the bench’s own checkout without it', async () => {
  const app = mkdtempSync(join(tmpdir(), 'pb-bench-app-'));
  const tmp = mkdtempSync(join(tmpdir(), 'pb-bench-test-'));
  try {
    mkdirSync(join(app, 'server'));
    writeFileSync(join(app, 'server', 'index.mjs'), '');
    const roots = [];
    const start = async ({ root }) => {
      roots.push(root);
      throw new Error('stub');
    };
    for (const argv of [['--app', app], []])
      await assert.rejects(
        measureSize(null, 200, options(argv), () => {}, { start, port: async () => 1, tmp }),
        /stub/,
      );
    assert.deepEqual(roots, [app, BENCH_ROOT]);
  } finally {
    rmSync(app, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('the report has a row per switch and measure for each size, and its provenance', () => {
  const s = (v) => ({ n: 5, p50: v, p95: v + 1, max: v + 2 });
  const report = formatReport({
    command: 'node tools/bench-switch.mjs --sizes 1000 --runs 5 --out r.md',
    commit: 'aaaa1111 (Postbox measured); bbbb2222 (the bench and its seed)',
    date: '2026-11-06T00:00:00.000Z',
    machine: { os: 'Linux 6', arch: 'x64', cpu: 'CPU', node: 'v24', chromium: '150' },
    conditions: { load: { start: 1, end: 2 }, headless: true, window: { width: 1280, height: 900 }, scale: 1 },
    inputs: { sizes: [1000], runs: 5 },
    results: [{ items: 1000, project: { drawn: s(100), key: s(200) }, conversation: { drawn: s(50), key: s(80) } }],
  });
  assert.match(report, /\| 1,000 \| Project switch \| Last item drawn \| 5 \| 100\.0 ms \| 101\.0 ms \| 102\.0 ms \|/);
  assert.match(report, /\| 1,000 \| Conversation switch \| Key’s next frame \| 5 \| 80\.0 ms \| 81\.0 ms \| 82\.0 ms \|/);
  assert.match(report, /- Commit: aaaa1111 \(Postbox measured\); bbbb2222 \(the bench and its seed\)/);
  assert.match(report, /- Command: `node tools\/bench-switch\.mjs --sizes 1000 --runs 5 --out r\.md`/);
  assert.match(report, /load average 1\.00 at the start and 2\.00 at the end/);
});

test('a run’s element counts are proved: the transcript has elements, and the page has at least as many', () => {
  assert.doesNotThrow(() => proveCounts({ page: 30_000, transcript: 25_000 }));
  assert.throws(() => proveCounts({ page: 30_000, transcript: 0 }), /counted no elements in the long room’s transcript/);
  assert.throws(() => proveCounts({ page: 100, transcript: 200 }), /counted 100 elements on the page but 200 in its transcript/);
});

test('the report has an element count per size and switch, with the transcript’s ratio to the smallest size', () => {
  const s = (v) => ({ n: 5, p50: v, p95: v + 1, max: v + 2 });
  const size = (items, page, transcript) => ({
    items,
    project: { drawn: s(100), key: s(200), elements: { page, transcript } },
    conversation: { drawn: s(50), key: s(80), elements: { page: page + 10, transcript: transcript + 10 } },
  });
  const report = formatReport({
    command: 'node tools/bench-switch.mjs --sizes 1000,10000 --runs 5 --out r.md',
    commit: 'aaaa1111',
    date: '2026-11-06T00:00:00.000Z',
    machine: { os: 'Linux 6', arch: 'x64', cpu: 'CPU', node: 'v24', chromium: '150' },
    conditions: { load: { start: 1, end: 2 }, headless: true, window: { width: 1280, height: 900 }, scale: 1 },
    inputs: { sizes: [1000, 10000], runs: 5 },
    results: [size(1000, 30_000, 24_000), size(10000, 270_000, 240_000)],
  });
  assert.match(report, /\| 1,000 \| Project switch \| 30,000 \| 24,000 \| 1\.00 \|/);
  assert.match(report, /\| 10,000 \| Project switch \| 270,000 \| 240,000 \| 10\.00 \|/);
  assert.match(report, /\| 10,000 \| Conversation switch \| 270,010 \| 240,010 \| 10\.00 \|/);
});

test('--seed picks the uniform big-room seed by default, or the real-shape one, and the command and report say which', () => {
  assert.equal(options([]).seed, 'uniform');
  assert.equal(options(['--seed', 'real']).seed, 'real');
  assert.throws(() => options(['--seed', 'odd']), /^Error: --seed takes uniform or real, not “odd”\.$/);
  assert.match(commandLine(options(['--seed', 'real']), ROOT), / --seed real --out /);
  assert.doesNotMatch(commandLine(options([]), ROOT), /--seed/);
  const s = (v) => ({ n: 1, p50: v, p95: v, max: v });
  const report = (seed) =>
    formatReport({
      command: 'c',
      commit: 'aaaa1111',
      date: 'd',
      machine: { os: 'L', arch: 'x', cpu: 'C', node: 'n', chromium: 'c' },
      conditions: { load: { start: 1, end: 2 }, headless: true, window: { width: 1280, height: 900 }, scale: 1 },
      inputs: { sizes: [1000], runs: 1, seed },
      results: [{ items: 1000, project: { drawn: s(1), key: s(2) }, conversation: { drawn: s(1), key: s(2) } }],
    });
  assert.match(report('real'), /items from the real-shape seed \(tools\/uat\/real-room\.mjs/);
  assert.match(report('uniform'), /items from the big-room seed \(tools\/uat\/big-room\.mjs\)/);
});

test('the long room’s last item is the seed’s own: it_big… for the uniform seed, it_real… for the real one', () => {
  assert.equal(lastIdOf('uniform', 1000), 'it_big0999');
  assert.equal(lastIdOf('real', 2000), 'it_real1999');
});

test('--needs adds the ⌃J switch, from one long room to a second in another project, and the command says so', () => {
  assert.equal(options([]).needs, false);
  assert.equal(options(['--needs']).needs, true);
  assert.match(commandLine(options(['--needs']), ROOT), / --needs --out /);
  assert.deepEqual(switchesFor(options([])), SWITCHES);
  const all = switchesFor(options(['--needs']));
  assert.deepEqual(all.at(-1), NEEDS_SWITCH);
  assert.deepEqual([NEEDS_SWITCH.from, NEEDS_SWITCH.to], [IDS.long, IDS.long2]);
});

test('with --needs, each long room ends on an open ask its agent needs you for, and that ask is the item a run ends on', () => {
  const rooms = expectedRooms({ items: 1000, seed: 'uniform', needs: true });
  assert.deepEqual(rooms[IDS.long], { thread: IDS.long, count: 1001, last: askId(IDS.long) });
  assert.deepEqual(rooms[IDS.long2], { thread: IDS.long2, count: 1001, last: askId(IDS.long2) });
  assert.deepEqual(expectedRooms({ items: 1000, seed: 'uniform', needs: false }), {
    [IDS.long]: { thread: IDS.long, count: 1000, last: 'it_big0999' },
  });
  const ask = openAsk(IDS.long2, 'researcher', 5);
  assert.equal(ask.item.id, askId(IDS.long2));
  assert.equal(ask.item.answered, undefined, 'the ask is open');
  assert.deepEqual(ask.need, { kind: 'block', itemId: askId(IDS.long2), threadId: IDS.long2, text: '@researcher asks you to confirm the release' });
});

test('the report shows the ⌃J switch’s rows when a run had it', () => {
  const s = (v) => ({ n: 1, p50: v, p95: v, max: v });
  const one = { drawn: s(1), key: s(2), elements: { page: 10, transcript: 5 } };
  const report = formatReport({
    command: 'c',
    commit: 'aaaa1111',
    date: 'd',
    machine: { os: 'L', arch: 'x', cpu: 'C', node: 'n', chromium: 'c' },
    conditions: { load: { start: 1, end: 2 }, headless: true, window: { width: 1280, height: 900 }, scale: 1 },
    inputs: { sizes: [1000], runs: 1 },
    results: [{ items: 1000, project: one, conversation: one, needs: one }],
  });
  assert.match(report, /\| 1,000 \| Next needs you \(⌃J\) \| Last item drawn \|/);
  assert.match(report, /\| 1,000 \| Next needs you \(⌃J\) \| 10 \| 5 \| 1\.00 \|/);
});
