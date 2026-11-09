// The real-shape seed’s snapshot (#305, designs/305-archive-turns.md, “Context: what the state holds today”):
// tools/seed-archive-snapshot.mjs seeds the big room with its work into a data folder and writes the store’s own
// snapshot.json, and tools/measure-archive-policies.mjs measures it. Both are processes writing a store to disk, so the
// test is here, not with the unit tests (tests/guard.mjs). It asserts what the tools print, never how long they took.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { tempDir } from '../temp-dirs.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
/** A tool of the repo’s, run by this Node, with a timeout. @param {string[]} args */
const run = (...args) => spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', timeout: 60000 });

test('the seeded snapshot is the store’s own, with the room’s work, and the policy measurement runs on it', () => {
  const out = tempDir('pb-test-seed-archive-');
  const seed = run('tools/seed-archive-snapshot.mjs', '--items', '300', '--out', out);
  assert.equal(seed.status, 0, seed.stderr);
  const path = join(out, 'snapshot.json');
  assert.ok(existsSync(path), seed.stdout);
  const state = JSON.parse(readFileSync(path, 'utf8'));
  const [conv] = Object.keys(state.work);
  assert.ok(state.work[conv].some((e) => e.kind === 'command'));
  assert.equal(state.items[conv].length, 300);
  assert.ok(state.items[conv].some((it) => it.turnId && it.activity?.steps?.length));

  const m = run('tools/measure-archive-policies.mjs', path);
  assert.equal(m.status, 0, m.stderr);
  const rows = m.stdout.split('\n').filter((l) => /^\s*\d+\.\d\d MB\s+\d+\.\d ms\s+-?\d+% smaller {2}\S/.test(l));
  assert.equal(rows.length, 8, m.stdout);
  assert.match(rows[0], /today \(nothing archived\)$/);
  assert.match(rows[0], / 0% smaller/);
  // Every policy archives something of a room with work, so each saves: 0% would mean it archived nothing (#1031).
  const savings = rows.slice(1).map((l) => Number(/ (-?\d+)% smaller/.exec(l)?.[1]));
  assert.ok(
    savings.every((s) => s > 0),
    `every archive policy makes the snapshot smaller: ${savings.join(', ')}`,
  );
  assert.match(m.stdout, /^I4: \d+ turns, of which turns with an entry left open hold \d+\.\d\d MB of \d+\.\d\d MB of work$/m);
  assert.doesNotMatch(m.stdout, /hold 0\.00 MB/, 'the seed has open turns');
  assert.match(m.stdout, /^A2: a turn's work is \d+ KB at most, \d+\.\d KB at the median \(\d+ turns\)$/m);
});

test('the seed tool refuses a folder that already holds a store, and leaves its snapshot as it was', () => {
  // Its one guard against seeding into a Postbox’s real data (#1031).
  const out = tempDir('pb-test-seed-archive-store-');
  writeFileSync(join(out, 'snapshot.json'), '{"kept":true}\n');
  const into = run('tools/seed-archive-snapshot.mjs', '--items', '10', '--out', out);
  assert.notEqual(into.status, 0);
  assert.match(into.stderr, /already holds a store\. Give --out a new or empty folder\./);
  assert.equal(readFileSync(join(out, 'snapshot.json'), 'utf8'), '{"kept":true}\n');
});

test('the seed tool refuses a missing folder or a count that isn’t a whole number, and writes nothing', () => {
  const out = tempDir('pb-test-seed-archive-bad-');
  const bad = run('tools/seed-archive-snapshot.mjs', '--items', '1e3', '--out', out);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /--items takes a whole number/);
  assert.ok(!existsSync(join(out, 'snapshot.json')));
  const none = run('tools/seed-archive-snapshot.mjs', '--items', '10');
  assert.notEqual(none.status, 0);
  assert.match(none.stderr, /--out/);
});
