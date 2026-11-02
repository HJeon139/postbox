import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { addedIgnores, capChanges, ceilings, configChanges, noBase } from '../tools/lint-caps.mjs';

const cap = (n) => ({ level: 'error', options: { maxLines: n } });
/** A biome.json with the repo's defaults, and the given overrides and includes. */
const biome = (overrides = [], includes = ['server/**', '!server/corpus/books']) => ({
  files: { includes },
  linter: { rules: { style: { noExcessiveLinesPerFile: cap(300) }, complexity: { noExcessiveLinesPerFunction: cap(50) } } },
  overrides,
});
const fileCap = (path, n) => ({ includes: [path], linter: { rules: { style: { noExcessiveLinesPerFile: n } } } });
const fnCap = (path, n) => ({ includes: [path], linter: { rules: { complexity: { noExcessiveLinesPerFunction: n } } } });
const existing = new Set(['server/runtime.mjs', 'server/small.mjs']);
const check = (base, head) => capChanges(ceilings(base), ceilings(head), (p) => existing.has(p));

test('lint-caps: a raised file or function ceiling fails, and a lowered or removed one passes', () => {
  const base = biome([fileCap('server/runtime.mjs', cap(3028)), fnCap('server/runtime.mjs', cap(200))]);
  assert.deepEqual(check(base, biome([fileCap('server/runtime.mjs', cap(3029)), fnCap('server/runtime.mjs', cap(200))])).problems, [
    'server/runtime.mjs: its file ceiling went up from 3028 to 3029.',
  ]);
  assert.match(
    check(base, biome([fileCap('server/runtime.mjs', cap(3028)), fnCap('server/runtime.mjs', cap(201))])).problems[0],
    /function ceiling went up from 200 to 201/,
  );
  assert.deepEqual(check(base, biome([fileCap('server/runtime.mjs', cap(2900))])), { problems: [], notes: [] });
});

test('lint-caps: a ceiling for a file that already existed fails; a new module’s is a note', () => {
  const head = biome([fileCap('server/small.mjs', cap(320)), fileCap('server/runtime-jobs.mjs', cap(410))]);
  const r = check(biome(), head);
  assert.deepEqual(r.problems, ['server/small.mjs: it gets a file ceiling of 320, over the default 300, and it isn’t a new module.']);
  assert.deepEqual(r.notes, ['server/runtime-jobs.mjs: a new module with a file ceiling of 410. Allowed only for code moved out of a file at its ceiling.']);
});

test('lint-caps: an override at or under the default is not a ceiling, and a glob never counts as a new module', () => {
  assert.deepEqual(check(biome(), biome([fileCap('server/small.mjs', cap(300))])).problems, []);
  assert.match(check(biome(), biome([fileCap('server/new/**', cap(400))])).problems[0], /server\/new\/\*\*: it gets a file ceiling of 400/);
});

test('lint-caps: turning a length rule or the linter off counts as raising the ceiling without limit', () => {
  const base = biome([fileCap('server/runtime.mjs', cap(3028))]);
  assert.match(check(base, biome([fileCap('server/runtime.mjs', 'off')])).problems[0], /went up from 3028 to Infinity/);
  assert.match(check(base, biome([fileCap('server/runtime.mjs', { level: 'off' })])).problems[0], /went up from 3028 to Infinity/);
  const disabled = biome([{ includes: ['server/small.mjs'], linter: { enabled: false } }]);
  assert.equal(check(biome(), disabled).problems.length, 2, 'both the file and the function rule');
  assert.match(check(biome(), { ...biome(), linter: { ...biome().linter, enabled: false } }).problems[0], /default file ceiling went up/);
});

test('lint-caps: a raised default, or a path taken out of what Biome checks, fails', () => {
  const raised = biome();
  raised.linter.rules.style.noExcessiveLinesPerFile = cap(400);
  assert.deepEqual(check(biome(), raised).problems, ['The default file ceiling went up from 300 to 400.']);
  assert.deepEqual(check(biome(), biome([], ['server/**', '!server/corpus/books', '!server/runtime.mjs'])).problems, [
    'Biome no longer checks “server/runtime.mjs”.',
  ]);
  assert.deepEqual(check(biome(), biome([], ['!server/corpus/books'])).problems, ['Biome no longer checks “server/**”.']);
  assert.deepEqual(check(biome(), biome([], ['server/**'])).problems, [], 'checking more is fine');
});

test('lint-caps: the repo’s own biome.json against itself changes nothing', () => {
  const own = JSON.parse(readFileSync(new URL('../biome.json', import.meta.url), 'utf8'));
  const c = ceilings(own);
  assert.equal(c.defaults.file, 300);
  assert.equal(c.defaults.fn, 50);
  assert.ok(c.paths.get('server/runtime.mjs')?.file > 300, 'the largest file has a ceiling');
  assert.deepEqual(
    capChanges(c, c, () => true),
    { problems: [], notes: [] },
  );
});

test('lint-caps: a Biome config other than the root biome.json, added or changed, fails', () => {
  const base = new Map([
    ['biome.json', 'a1'],
    ['app/kit/biome.json', 'b1'],
  ]);
  assert.deepEqual(configChanges(base, new Map([...base, ['server/biome.json', 'c1']])), ['A Biome config was added or changed: server/biome.json.']);
  assert.deepEqual(
    configChanges(
      base,
      new Map([
        ['biome.json', 'a1'],
        ['app/kit/biome.json', 'b2'],
      ]),
    ),
    ['A Biome config was added or changed: app/kit/biome.json.'],
  );
  assert.deepEqual(configChanges(base, new Map([...base, ['biome.jsonc', 'd1']])), ['A Biome config was added or changed: biome.jsonc.']);
  assert.deepEqual(
    configChanges(
      base,
      new Map([
        ['biome.json', 'a2'],
        ['app/kit/biome.json', 'b1'],
      ]),
    ),
    [],
    'the root one is read rule by rule',
  );
  assert.deepEqual(configChanges(base, new Map([['biome.json', 'a1']])), [], 'removing one is fine');
});

test('lint-caps: a changed extends fails, since it can bring in other rules', () => {
  assert.deepEqual(check(biome(), { ...biome(), extends: ['./loose.json'] }).problems, ['biome.json’s extends changed.']);
});

test('lint-caps: a biome-ignore added where another was removed still counts as added', () => {
  const base = ['server/a.mjs:// biome-ignore lint/style/noExcessiveLinesPerFile: old'];
  const head = ['server/b.mjs:// biome-ignore lint/style/noExcessiveLinesPerFile: new'];
  assert.deepEqual(addedIgnores(base, head), head);
  assert.deepEqual(addedIgnores([...base, ...base], base), []);
  assert.deepEqual(addedIgnores(base, [...base, ...base]), base, 'a second copy of the same line is new');
});

test('lint-caps: with no base to compare with, it fails in CI and skips elsewhere', () => {
  assert.deepEqual(noBase('origin/main', { CI: 'true' }), { code: 1, message: 'lint-caps: failed, there is no origin/main to compare with.' });
  assert.deepEqual(noBase('origin/main', {}), { code: 0, message: 'lint-caps: skipped, there is no origin/main to compare with.' });
});

test('lint-caps: a level that doesn’t fail the gate counts as turning the rule off', () => {
  const base = biome([fileCap('server/runtime.mjs', cap(3028))]);
  for (const level of ['info', 'none'])
    assert.match(
      check(base, biome([fileCap('server/runtime.mjs', { level, options: { maxLines: 3028 } })])).problems[0],
      /went up from 3028 to Infinity/,
      level,
    );
  assert.match(check(base, biome([fileCap('server/runtime.mjs', 'info')])).problems[0], /to Infinity/);
  for (const level of ['error', 'warn', 'on'])
    assert.deepEqual(check(base, biome([fileCap('server/runtime.mjs', { level, options: { maxLines: 3028 } })])).problems, [], level);
});

test('lint-caps: a path spelled with ./ is the same path', () => {
  const base = biome([fileCap('server/runtime.mjs', cap(3028))]);
  assert.deepEqual(check(base, biome([fileCap('./server/runtime.mjs', cap(9999))])).problems, [
    'server/runtime.mjs: its file ceiling went up from 3028 to 9999.',
  ]);
});

test('lint-caps: a new module with a length rule off or at a non-failing level fails, not a note', () => {
  for (const rule of ['off', { level: 'info', options: { maxLines: 400 } }]) {
    const r = check(biome(), biome([fileCap('server/runtime-jobs.mjs', rule)]));
    assert.deepEqual(r.problems, ['server/runtime-jobs.mjs: a new module with its file length rule off, which no moved code can need.']);
    assert.deepEqual(r.notes, []);
  }
});
