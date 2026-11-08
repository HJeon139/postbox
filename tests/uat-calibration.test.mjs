// Calibrating #995’s side-by-side judge (tools/uat/calibration.mjs): the maintainer’s blind page, and the judge’s
// agreement with their picks; and a pair for a run that finished before the judge (tools/uat/pairs-backfill.mjs).

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { agreement, calibrationPage } from '../tools/uat/calibration.mjs';
import { firstJudged } from '../tools/uat/pairs-backfill.mjs';

const pair = (n, judge) => ({
  run: `run-${n}`,
  persona: 'Someone with <many> subscriptions.',
  question: 'Which should I cancel?',
  reply: 'Cancel **six**.',
  shot: '/nowhere.png',
  words: '| Cancel | Saves |\n|---|---|\n| Gym | $59 |',
  judge,
});

test('#995 the page shows each pair blind: no run, no judge’s pick, the person’s words as text', (t) => {
  const out = join(mkdtempSync(join(tmpdir(), 'pb-calibrate-')), 'page');
  t.after(() => rmSync(join(out, '..'), { recursive: true }));
  const picks = [0.2, 0.8];
  const key = calibrationPage([pair(1, 'picture'), pair(2, 'words')], { out, random: () => picks.shift() ?? 0 });
  assert.deepEqual(key, [
    { n: 1, run: 'run-1', pictureAs: 'A', judge: 'picture' },
    { n: 2, run: 'run-2', pictureAs: 'B', judge: 'words' },
  ]);
  const html = readFileSync(join(out, 'index.html'), 'utf8');
  assert.ok(!html.includes('run-1') && !/judge/i.test(html.replace(/Judge what each/g, '')), 'nothing tells which run or what the judge picked');
  assert.match(html, /Someone with &lt;many&gt; subscriptions\./, 'the persona is text, not HTML');
  assert.match(html, /<table>/, 'the words answer is rendered as Postbox renders Markdown');
  // Pair 1 has the picture as A, pair 2 as B.
  const [one, two] = html.split('<article').slice(1);
  assert.ok(one.indexOf('1-picture.png') < one.indexOf('<h3>Answer B</h3>'));
  assert.ok(two.indexOf('2-picture.png') > two.indexOf('<h3>Answer B</h3>'));
  assert.deepEqual(readdirSync(out), ['index.html'], 'the key isn’t in the page’s folder; a missing picture isn’t copied');
});

test('#995 agreement reads the maintainer’s A and B back as picture or words, and discounts chance agreement', () => {
  const key = [
    { n: 1, pictureAs: 'A', judge: 'picture' },
    { n: 2, pictureAs: 'B', judge: 'picture' },
    { n: 3, pictureAs: 'A', judge: 'words' },
    { n: 4, pictureAs: 'B', judge: 'tie' },
    { n: 5, pictureAs: 'A', judge: 'words' },
  ];
  const picks = [
    { n: 1, pick: 'A' }, // the picture: same
    { n: 2, pick: 'A' }, // the words: differs
    { n: 3, pick: 'B' }, // the words: same
    { n: 4, pick: 'tie' }, // same
    { n: 5, pick: null }, // no pick: left out
  ];
  const a = agreement(key, { picks });
  assert.equal(a.pairs, 4);
  assert.equal(a.same, 3);
  assert.equal(a.observed, 0.75);
  assert.deepEqual(a.person, { picture: 1, words: 2, tie: 1 });
  assert.deepEqual(a.judge, { picture: 2, words: 1, tie: 1 });
  // Chance: 1/4·2/4 + 2/4·1/4 + 1/4·1/4 = 5/16, so κ = (12/16 − 5/16) / (11/16) = 7/11.
  assert.ok(Math.abs(/** @type {number} */ (a.kappa) - 7 / 11) < 1e-9);
  assert.equal(agreement(key, { picks: [] }).kappa, null);
});

test('#995 a finished run’s picture is the item its customer judged first', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pb-backfill-'));
  t.after(() => rmSync(dir, { recursive: true }));
  writeFileSync(join(dir, 'report.md'), '## Visual verdicts\n\n| Step | Item |\n|---|---|\n| 5 | I3 | landed |\n| 6 | I9 | partly |\n');
  assert.equal(firstJudged(readFileSync(join(dir, 'report.md'), 'utf8')), 'I3');
  assert.equal(firstJudged('## Timeline\n\n| 5 | I3 |'), null, 'only from the visual verdicts');
  assert.equal(existsSync(join(dir, 'run.json')), false);
});
