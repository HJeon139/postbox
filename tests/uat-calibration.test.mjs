// Calibrating #995’s side-by-side judge (tools/uat/calibration.mjs): a scenario’s runs paired with its `-base` twin’s,
// the maintainer’s blind page of picture against picture, and the judge’s agreement with their picks; and the first
// picture of a run that finished before it was recorded (tools/uat/pairs-backfill.mjs).

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { agreement, arenaPairs, calibrationPage, PAGE_CSP, twinPairs } from '../tools/uat/calibration.mjs';
import { firstJudged } from '../tools/uat/pairs-backfill.mjs';

test('#995 a scenario’s runs pair with its -base twin’s, newest first, one scenario after another', () => {
  const run = (scenario, run) => ({ run, scenario, picture: {} });
  const runs = [
    run('subs', '2026-11-07-a'),
    run('subs', '2026-11-08-a'),
    run('subs-base', '2026-11-07-b'),
    run('tests', '2026-11-08-c'),
    run('tests-base', '2026-11-08-d'),
    run('shelf', '2026-11-08-e'), // no twin
  ];
  const pairs = twinPairs(runs, 3).map((p) => [p.skill.run, p.base.run]);
  assert.deepEqual(pairs, [
    ['2026-11-08-a', '2026-11-07-b'],
    ['2026-11-08-c', '2026-11-08-d'],
  ]);
  assert.equal(twinPairs(runs, 1).length, 1);
});

test('#995 the page shows two pictures and what each meant to say, with no run, condition or reply on it', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pb-calibrate-'));
  t.after(() => rmSync(dir, { recursive: true }));
  for (const f of ['skill.png', 'base.png']) writeFileSync(join(dir, f), 'png');
  const out = join(dir, 'page');
  const sides = [
    { file: join(dir, 'base.png'), intent: 'Cancel <the> gym.', intentFrom: 'fallback' },
    { file: join(dir, 'skill.png'), intent: 'Six cost over $10 a use.', intentFrom: 'agent' },
  ];
  calibrationPage([{ persona: 'Someone with many subscriptions.', question: 'Which should I cancel?', sides }], out);
  assert.deepEqual(readdirSync(out).sort(), ['1-a.png', '1-b.png', 'index.html']);
  const html = readFileSync(join(out, 'index.html'), 'utf8');
  // What a person sees: the body up to </main>. The head’s policy and the script after </main> aren’t on screen.
  const shown = html.slice(html.indexOf('<body>'), html.indexOf('</main>'));
  assert.ok(shown.includes('<h1>Picture against picture'), 'the cut holds the page’s text');
  assert.ok(!/skill|base|everyday/i.test(shown), 'nothing tells which condition a picture came from');
  assert.match(html, /The agent’s text version of it \(it gave no intent\)<\/span>: “Cancel &lt;the&gt; gym\.”/);
  assert.match(html, /What the agent meant it to say<\/span>: “Six cost over \$10 a use\.”/);
  assert.ok(html.indexOf('1-a.png') < html.indexOf('1-b.png'));
});

test('#995 agreement reads A and B back as the skill’s or the baseline’s picture, and discounts chance agreement', () => {
  const key = [
    { n: 1, skillAs: 'A', judge: { pick: 'A' } }, // skill, skill: same
    { n: 2, skillAs: 'B', judge: { pick: 'B' } }, // skill, person base: differs
    { n: 3, skillAs: 'A', judge: { pick: 'B' } }, // base, base: same
    { n: 4, skillAs: 'B', judge: { pick: 'tie' } }, // same
    { n: 5, skillAs: 'A', judge: { pick: 'A' } }, // no pick: left out
  ];
  const picks = [
    { n: 1, pick: 'A' },
    { n: 2, pick: 'A' },
    { n: 3, pick: 'B' },
    { n: 4, pick: 'tie' },
    { n: 5, pick: null },
  ];
  const a = agreement(key, { picks });
  assert.equal(a.pairs, 4);
  assert.equal(a.same, 3);
  assert.deepEqual(a.person, { skill: 1, base: 2, tie: 1 });
  assert.deepEqual(a.judge, { skill: 2, base: 1, tie: 1 });
  // Chance: 1/4·2/4 + 2/4·1/4 + 1/4·1/4 = 5/16, so κ = (12/16 − 5/16) / (11/16) = 7/11.
  assert.ok(Math.abs(/** @type {number} */ (a.kappa) - 7 / 11) < 1e-9);
  assert.equal(agreement(key, { picks: [] }).kappa, null);
});

test('#995 a finished run’s picture is the item its customer judged first', () => {
  const report = '## Visual verdicts\n\n| Step | Item |\n|---|---|\n| 5 | I3 | landed |\n| 6 | I9 | partly |\n';
  assert.equal(firstJudged(report), 'I3');
  assert.equal(firstJudged('## Timeline\n\n| 5 | I3 |'), null, 'only from the visual verdicts');
});

test('#995 a person is never shown a brief, a question or a screenshot twice; the judge alone may be', () => {
  const r = (scenario, run, question, shot) => ({ scenario, run, picture: { question, shot } });
  const pairs = [
    { skill: r('subs', 'a', 'Cancel?', 's1.png'), base: r('subs-base', 'b', 'Cancel?', 's1.png') },
    { skill: r('subs', 'c', 'Cancel?', 's1.png'), base: r('subs-base', 'd', 'Cancel?', 's1.png') }, // the same brief again
    { skill: r('tests', 'e', 'Cancel?', 's1.png'), base: r('tests-base', 'f', 'Cancel?', 's1.png') }, // the same question
    { skill: r('shelf', 'a', 'What have I got?', 's1.png'), base: r('shelf-base', 'g', 'What have I got?', 's1.png') }, // run a’s shot again
    { skill: r('pantry', 'h', 'How is it saved?', 's1.png'), base: r('pantry-base', 'i', 'How is it saved?', 's1.png') },
  ];
  assert.deepEqual(
    arenaPairs(pairs).map((p) => p.skill.run),
    ['a', 'h'],
  );
});

test('#995 the page loads nothing from elsewhere: its CSP allows its own pictures, and its style and script by hash', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pb-calibrate-'));
  t.after(() => rmSync(dir, { recursive: true }));
  writeFileSync(join(dir, 'p.png'), 'png');
  const sides = [
    { file: join(dir, 'p.png'), intent: 'One.', intentFrom: 'agent' },
    { file: join(dir, 'p.png'), intent: '', intentFrom: null },
  ];
  calibrationPage([{ persona: 'Someone.', question: 'Q?', sides }], join(dir, 'page'));
  const html = readFileSync(join(dir, 'page', 'index.html'), 'utf8');
  assert.ok(html.includes(`<meta http-equiv="Content-Security-Policy" content="${PAGE_CSP}">`));
  assert.match(PAGE_CSP, /^default-src 'none'; img-src 'self';/);
  const hash = (text) => `'sha256-${createHash('sha256').update(text).digest('base64')}'`;
  // The text between the page’s one <tag> and its </tag>, which calibrationPage writes in lower case.
  const inline = (tag) => html.slice(html.indexOf(`<${tag}>`) + tag.length + 2, html.indexOf(`</${tag}>`));
  assert.ok(PAGE_CSP.includes(`script-src ${hash(inline('script'))}`), 'the script’s hash is the one the policy allows');
  assert.ok(PAGE_CSP.includes(`style-src ${hash(inline('style'))}`), 'the style’s hash is the one the policy allows');
});
