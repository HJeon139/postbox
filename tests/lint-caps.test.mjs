import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { addedLines, ceilings, configChanges, configDiff, suppressions } from '../tools/lint-caps.mjs';
import { noBase } from '../tools/merge-base.mjs';

const cap = (n, extra = {}) => ({ level: 'error', options: { maxLines: n, ...extra } });
/** A biome.json with the repo's defaults, and the given overrides. */
const biome = (overrides = [], extra = {}) => ({
  files: { includes: ['server/**', '!server/corpus/books'] },
  linter: { rules: { style: { noExcessiveLinesPerFile: cap(300) }, complexity: { noExcessiveLinesPerFunction: cap(50) } } },
  overrides,
  ...extra,
});
const fileCap = (path, rule) => ({ includes: [path], linter: { rules: { style: { noExcessiveLinesPerFile: rule } } } });
/** One override with both length rules, as biome.json has them. */
const both = (path, file, fn) => ({
  includes: [path],
  linter: { rules: { style: { noExcessiveLinesPerFile: file }, complexity: { noExcessiveLinesPerFunction: fn } } },
});
const RT = 'server/runtime.mjs';
const MAIN = fileCap('app/js/main.mjs', cap(244));
const base = biome([both(RT, cap(3028), cap(200)), MAIN]);
const withRt = (rule, fn = cap(200)) => biome([both(RT, rule, fn), MAIN]);

test('lint-caps: only a lower maxLines passes; a higher one, another level or another option fails', () => {
  assert.deepEqual(configDiff(base, withRt(cap(2900))), []);
  assert.match(configDiff(base, withRt(cap(3029)))[0], /\["server\/runtime.mjs"\]: its file length rule went from .*3028.* to .*3029/);
  for (const loose of [{ level: 'info', options: { maxLines: 3028 } }, 'off', cap(3000, { skipBlankLines: true })])
    assert.equal(configDiff(base, withRt(loose)).length, 1, JSON.stringify(loose));
  assert.match(configDiff(base, withRt(cap(3028), cap(201)))[0], /function length rule went from/);
});

test('lint-caps: removing an override passes unless it held a limit under the default', () => {
  assert.deepEqual(configDiff(base, biome([MAIN])), []);
  assert.deepEqual(configDiff(base, biome([both(RT, cap(3028), cap(200))])), [
    '["app/js/main.mjs"]: its file length rule was removed, which raises it to the default 300.',
  ]);
});

test('lint-caps: a new override may not carry a ceiling over the default, even for moved code (the person, 2 November 2026)', () => {
  const moved = biome([both('server/runtime/index.mjs', cap(3028), cap(200)), MAIN]);
  assert.deepEqual(configDiff(base, moved), [
    '["server/runtime/index.mjs"]: its file length rule was added; a new one may hold only a failing level and a maxLines at or under the default 300.',
    '["server/runtime/index.mjs"]: its function length rule was added; a new one may hold only a failing level and a maxLines at or under the default 50.',
  ]);
  assert.equal(configDiff(base, biome([...base.overrides, fileCap('server/runtime/turns.mjs', cap(2000))])).length, 1);
  assert.equal(configDiff(base, biome([...base.overrides, fileCap('server/runtime/turns.mjs', 'off')])).length, 1);
  assert.deepEqual(configDiff(base, biome([...base.overrides, fileCap('server/new.mjs', cap(250))])), [], 'under the default is fine');
  const other = { includes: ['server/new.mjs'], linter: { rules: { suspicious: { noExplicitAny: 'off' } } } };
  assert.deepEqual(configDiff(base, biome([...base.overrides, other])), [], 'a rule that isn’t about length is fine');
  const disabled = { includes: ['server/new.mjs'], linter: { enabled: false } };
  assert.deepEqual(configDiff(base, biome([...base.overrides, disabled])), ['["server/new.mjs"]: linter.enabled changed.']);
});

test('lint-caps: the integrator’s four bypasses fail', () => {
  const brace = biome([...base.overrides, fileCap('server/{runtime,zz}.mjs', cap(9999))]);
  assert.match(configDiff(base, brace)[0], /server\/\{runtime,zz\}\.mjs"\]: its file length rule was added; a new one may hold only/);
  const noTop = biome(base.overrides);
  delete noTop.linter.rules.style.noExcessiveLinesPerFile;
  assert.deepEqual(configDiff(base, noTop), ['biome.json: its file length rule was removed, which leaves no limit.']);
  assert.deepEqual(suppressions(['server/zz.mjs:// biome-ignore-all lint/style: generated']), ['server/zz.mjs:// biome-ignore-all lint/style: generated']);
  const linterIncludes = biome(base.overrides);
  linterIncludes.linter.includes = ['**', '!server/zz-big.mjs'];
  assert.deepEqual(configDiff(base, linterIncludes), ['biome.json: linter.includes gained “!server/zz-big.mjs”.']);
});

test('lint-caps: an unknown or unsafe key fails, and a key that can’t touch length passes', () => {
  assert.deepEqual(configDiff(base, biome(base.overrides, { plugins: ['./x.grit'] })), ['biome.json: “plugins” changed.']);
  assert.deepEqual(configDiff(base, biome(base.overrides, { extends: ['./loose.json'] })), ['biome.json: “extends” changed.']);
  assert.deepEqual(configDiff(base, biome(base.overrides, { formatter: { lineWidth: 100 } })), []);
  const maxSize = biome(base.overrides);
  maxSize.files.maxSize = 1000;
  assert.deepEqual(configDiff(base, maxSize), ['files.maxSize changed.']);
});

test('lint-caps: an includes list may only gain positive entries or lose `!` ones, in order', () => {
  const inc = (list) => ({ ...biome(base.overrides), files: { includes: list } });
  assert.deepEqual(configDiff(base, inc(['server/**', 'tools/**', '!server/corpus/books'])), []);
  assert.deepEqual(configDiff(base, inc(['server/**'])), []);
  assert.deepEqual(configDiff(base, inc(['!server/corpus/books'])), ['files.includes no longer has “server/**”.']);
  assert.deepEqual(configDiff(base, inc(['server/**', '!server/corpus/books', '!server/runtime.mjs'])), ['files.includes gained “!server/runtime.mjs”.']);
  assert.deepEqual(configDiff(base, inc(['!server/corpus/books', 'server/**'])), ['files.includes was reordered.']);
});

test('lint-caps: reordered or duplicated overrides fail', () => {
  const [a, b] = base.overrides;
  assert.deepEqual(configDiff(base, biome([b, a])), ['The overrides were reordered.']);
  assert.ok(configDiff(base, biome([a, b, a])).includes('Two overrides have the same includes.'));
});

test('lint-caps: a suppression is found by its shape, whatever rule set it covers', () => {
  const hits = [
    'a.mjs:// biome-ignore lint: x',
    'a.mjs:// biome-ignore lint/style: x',
    'a.mjs:/* biome-ignore-start lint/complexity: x */',
    'a.mjs:// biome-ignore-end lint/complexity',
    'a.mjs:// biome-ignore lint/style/noExcessiveLinesPerFile: x',
    'a.mjs:// biome-ignore lint/suspicious/noDebugger lint/style: x',
  ];
  const misses = ['a.mjs:// biome-ignore lint/style/useConst: x', 'a.mjs:// biome-ignore format: x', 'a.mjs:// biome-ignore lint/suspicious/noDebugger: x'];
  assert.deepEqual(suppressions([...hits, ...misses]), hits);
});

test('lint-caps: added lines are matched one for one', () => {
  const a = 'server/a.mjs:// biome-ignore lint/style: old';
  const b = 'server/b.mjs:// biome-ignore lint/style: new';
  assert.deepEqual(addedLines([a], [b]), [b]);
  assert.deepEqual(addedLines([a, a], [a]), []);
  assert.deepEqual(addedLines([a], [a, a]), [a]);
});

test('lint-caps: a Biome config other than the root biome.json, added or changed, fails', () => {
  const b = new Map([
    ['biome.json', 'a1'],
    ['app/kit/biome.json', 'b1'],
  ]);
  assert.deepEqual(configChanges(b, new Map([...b, ['server/biome.json', 'c1']])), ['A Biome config was added or changed: server/biome.json.']);
  assert.deepEqual(configChanges(b, new Map([...b, ['biome.jsonc', 'd1']])), ['A Biome config was added or changed: biome.jsonc.']);
  assert.deepEqual(
    configChanges(
      b,
      new Map([
        ['biome.json', 'a2'],
        ['app/kit/biome.json', 'b1'],
      ]),
    ),
    [],
    'the root one is read key by key',
  );
});

test('lint-caps: with no base to compare with, it fails in CI and skips elsewhere', () => {
  assert.equal(noBase('lint-caps', 'origin/main', { CI: 'true' }).code, 1);
  assert.equal(noBase('lint-caps', 'origin/main', {}).code, 0);
});

test('lint-caps: the repo’s own biome.json against itself has no difference', () => {
  const own = JSON.parse(readFileSync(new URL('../biome.json', import.meta.url), 'utf8'));
  const c = ceilings(own);
  assert.equal(c.defaults.file, 300);
  assert.equal(c.defaults.function, 50);
  assert.ok(c.paths.get(RT)?.file > 300, 'the largest file has a ceiling');
  assert.deepEqual(configDiff(own, own), []);
});

test('lint-caps: a new override’s length rule may hold only a level and a maxLines', () => {
  for (const extra of [{ skipBlankLines: true }, { someNewOption: 1 }]) {
    const loose = biome([...base.overrides, fileCap('server/new.mjs', cap(300, extra))]);
    assert.deepEqual(
      configDiff(base, loose),
      ['["server/new.mjs"]: its file length rule was added; a new one may hold only a failing level and a maxLines at or under the default 300.'],
      JSON.stringify(extra),
    );
  }
  const fnLoose = biome([
    ...base.overrides,
    { includes: ['**/*.mjs'], linter: { rules: { complexity: { noExcessiveLinesPerFunction: cap(50, { skipBlankLines: true }) } } } },
  ]);
  assert.equal(configDiff(base, fnLoose).length, 1);
  const extraKey = biome([...base.overrides, fileCap('server/new.mjs', { level: 'error', options: { maxLines: 300 }, fix: 'none' })]);
  assert.equal(configDiff(base, extraKey).length, 1, 'a key beside level and options');
});
