// PF-1’s key-to-frame bench (#508, tools/bench-key-frame.mjs): its options, the command its report shows, and what it
// leaves behind when a size’s Postbox doesn’t start.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { BENCH_ROOT, commandLine, commitLine, measureSize, options, provenance } from '../tools/bench-key-frame.mjs';

// A home folder under a prefix, as on a Cloud Desktop: replacing the home with ~ turned /local/home/user/… into /local~/….
const ROOT = '/local/home/user/postbox';

test('the report’s command shows --out relative to the repo, or as just its name outside it, never an absolute path', () => {
  const inside = commandLine(options(['--sizes', '200,800', '--out', `${ROOT}/designs/508/key-frame.md`]), ROOT);
  const outside = commandLine(options(['--out', '/local/home/user/elsewhere/report.md']), ROOT);
  assert.match(inside, / --out designs\/508\/key-frame\.md$/);
  assert.match(outside, / --out report\.md$/);
  for (const shown of [inside, outside]) assert.doesNotMatch(shown, /\/local|~/, shown);
});

test('the numeric options take positive whole numbers', () => {
  const o = options(['--sizes', '200, 800', '--keys', '40', '--warmup', '5', '--runs', '2', '--interval', '25']);
  assert.deepEqual([o.sizes, o.keys, o.warmup, o.runs, o.intervalMs], [[200, 800], 40, 5, 2, 25]);
});

test('a numeric option that isn’t a positive whole number is refused, naming the option and the value', () => {
  for (const name of ['keys', 'warmup', 'runs', 'interval', 'sizes'])
    for (const raw of ['0', '-5', '2.5', 'abc', '', '1e3', '0x10'])
      assert.throws(
        () => options([`--${name}=${raw}`]),
        new RegExp(`^Error: --${name} takes a whole number of at least 1, not “${raw}”\\.$`),
        `--${name}=${raw}`,
      );
  assert.throws(() => options(['--sizes', '1000,,4000']), /--sizes takes a whole number of at least 1, not “”/);
});

test('a size whose Postbox doesn’t start leaves no data folder behind', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'pb-bench-test-'));
  try {
    const start = async () => {
      throw new Error('Postbox didn’t start: refused');
    };
    const o = options(['--sizes', '200']);
    await assert.rejects(
      measureSize(null, 200, o, () => {}, { start, port: async () => 1, tmp }),
      /Postbox didn’t start: refused/,
    );
    assert.deepEqual(readdirSync(tmp), []);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('--app names the checkout whose Postbox is measured; without it, the bench measures its own', () => {
  const app = mkdtempSync(join(tmpdir(), 'pb-bench-app-'));
  try {
    mkdirSync(join(app, 'server'));
    writeFileSync(join(app, 'server', 'index.mjs'), '');
    assert.equal(options(['--app', app]).app, app);
    assert.equal(options([]).app, null);
    assert.match(commandLine(options(['--app', app]), ROOT), / --app pb-bench-app-\w+ --out /);
    assert.doesNotMatch(commandLine(options([]), ROOT), /--app/);
  } finally {
    rmSync(app, { recursive: true, force: true });
  }
});

test('--app that isn’t a Postbox checkout is refused, naming it', () => {
  const empty = mkdtempSync(join(tmpdir(), 'pb-bench-app-'));
  try {
    assert.throws(() => options(['--app', empty]), /^Error: --app takes a Postbox checkout, with server\/index\.mjs; .+ has none\.$/);
  } finally {
    rmSync(empty, { recursive: true, force: true });
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
      throw new Error('Postbox didn’t start: stub');
    };
    for (const argv of [['--app', app], []])
      await assert.rejects(
        measureSize(null, 200, options(argv), () => {}, { start, port: async () => 1, tmp }),
        /stub/,
      );
    assert.equal(roots[0], app);
    assert.equal(roots[1], BENCH_ROOT);
  } finally {
    rmSync(app, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('the report names the measured app’s commit, and the bench’s when they differ', () => {
  const commitOf = (root) => ({ '/app': 'aaaa1111', '/bench': 'bbbb2222' })[root];
  assert.equal(commitLine('/app', '/bench', commitOf), 'aaaa1111 (Postbox measured); bbbb2222 (the bench and its seed)');
  assert.equal(commitLine('/bench', '/bench', commitOf), 'bbbb2222');
});

test('the report’s provenance names --app’s commit beside the bench’s', () => {
  const app = mkdtempSync(join(tmpdir(), 'pb-bench-app-'));
  try {
    mkdirSync(join(app, 'server'));
    writeFileSync(join(app, 'server', 'index.mjs'), '');
    const commit = (root) => (root === app ? 'aaaa1111' : 'bbbb2222');
    assert.equal(provenance(options(['--app', app]), commit).commit, 'aaaa1111 (Postbox measured); bbbb2222 (the bench and its seed)');
    assert.equal(provenance(options([]), commit).commit, 'bbbb2222');
  } finally {
    rmSync(app, { recursive: true, force: true });
  }
});
