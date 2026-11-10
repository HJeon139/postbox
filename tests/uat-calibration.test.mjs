// Calibrating #995’s side-by-side judge (tools/uat/calibration.mjs): a scenario’s runs paired with its `-base` twin’s,
// the maintainer’s blind page of picture against picture, and the judge’s agreement with their picks; and the first
// picture of a run that finished before it was recorded (tools/uat/pairs-backfill.mjs).

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { agreement, arenaPairs, calibrationPage, judgeIntoKey, PAGE_CSP, pageId, shownBefore, twinPairs } from '../tools/uat/calibration.mjs';
import { firstJudged, pictureOfRun } from '../tools/uat/pairs-backfill.mjs';

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
  const shown = html.slice(html.indexOf('<body'), html.indexOf('</main>'));
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

test('#995 each page keeps its picks under its own name, so one page’s picks never fill in another’s', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pb-calibrate-'));
  t.after(() => rmSync(dir, { recursive: true }));
  writeFileSync(join(dir, 'one.png'), 'one');
  writeFileSync(join(dir, 'two.png'), 'two');
  const one = { file: join(dir, 'one.png'), intent: 'One.', intentFrom: 'agent' };
  const two = { file: join(dir, 'two.png'), intent: 'Two.', intentFrom: 'agent' };
  const pair = (question, sides) => ({ persona: 'Someone.', question, sides });
  const first = [pair('Q?', [one, two])];
  assert.equal(pageId(first), pageId([pair('Q?', [one, two])]), 'the same page keeps its name, and its picks');
  assert.notEqual(pageId(first), pageId([pair('Q?', [two, one])]), 'a rebuild that swaps the sides starts empty');
  assert.notEqual(pageId(first), pageId([pair('Other?', [one, two])]), 'another page starts empty');
  const before = pageId(first);
  writeFileSync(join(dir, 'one.png'), 'a different picture');
  assert.notEqual(before, pageId(first), 'other pictures with the same sentences are another page');
  calibrationPage(first, join(dir, 'page'));
  const html = readFileSync(join(dir, 'page', 'index.html'), 'utf8');
  assert.ok(html.includes(`<body data-page="${pageId(first)}">`));
  assert.ok(html.includes("const saved='picks-'+document.body.dataset.page;"));
  assert.ok(!html.includes('picks-995'), 'no name shared by every page');
});

test('#995 a failed judge call keeps the key: which side was which, and what the call cost', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pb-calibrate-'));
  t.after(() => rmSync(dir, { recursive: true }));
  const file = join(dir, 'page-key.json');
  const read = () => JSON.parse(readFileSync(file, 'utf8'));
  const key = [1, 2, 3].map((n) => ({ n, skillAs: 'A', judge: null, cost: 0 }));
  const onDisk = [];
  const result = await judgeIntoKey(key, file, async ({ n }) => {
    onDisk.push(read().map((k) => k.skillAs));
    if (n === 2) throw Object.assign(new Error('No answer.'), { cost: 0.03 });
    return { pick: 'A', why: 'Clearer.', cost: 0.05 };
  });
  assert.deepEqual(onDisk[0], ['A', 'A', 'A'], 'written before the first call');
  assert.equal(result.failed, 1);
  assert.ok(Math.abs(result.spent - 0.13) < 1e-9, 'the failed call’s cost counts');
  assert.deepEqual(read()[1], { n: 2, skillAs: 'A', judge: null, cost: 0.03, error: 'No answer.' });
  assert.deepEqual(read()[2].judge, { pick: 'A', why: 'Clearer.' }, 'the calls after it still ran');
  const a = agreement(read(), { picks: [1, 2, 3].map((n) => ({ n, pick: 'A' })) });
  assert.equal(a.pairs, 2, 'the pair with no judge’s pick is left out');
});

test('#995 no repeats hold across pages: what an earlier page showed is left out, and a judge-only key doesn’t count', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pb-calibrate-'));
  t.after(() => rmSync(dir, { recursive: true }));
  const stamp = '2026-11-08T02-22-03';
  const write = (name, key) => writeFileSync(join(dir, name), JSON.stringify(key));
  write('old-key.json', [{ n: 1, run: `${stamp}-words`, pictureAs: 'A', judge: 'picture' }]);
  write('page-key.json', [{ n: 1, skill: `${stamp}-subs`, base: `${stamp}-subs-base`, question: 'Cancel?', person: true }]);
  write('model-key.json', [{ n: 1, skill: `${stamp}-model`, base: `${stamp}-model-base`, question: 'Judged only?', person: false }]);
  writeFileSync(join(dir, 'other.json'), 'not a key');
  const { seen, pages } = shownBefore(dir);
  assert.deepEqual(pages, ['old-key.json', 'page-key.json']);
  assert.ok(seen.has(`run:${stamp}-words`) && seen.has('brief:words'), 'a key from the first page format counts');
  assert.ok(seen.has('brief:subs') && seen.has('question:Cancel?') && seen.has(`run:${stamp}-subs-base`));
  assert.ok(!seen.has('brief:model') && !seen.has('question:Judged only?'), 'no person saw the judge-only pairs');
  const pair = (scenario, question) => ({
    skill: { scenario, run: `new-${scenario}`, picture: { question, shot: 'a.png' } },
    base: { scenario: `${scenario}-base`, run: `new-${scenario}-base`, picture: { question, shot: 'b.png' } },
  });
  const left = arenaPairs([pair('subs', 'New wording?'), pair('tests', 'Cancel?'), pair('shelf', 'What have I got?')], seen);
  assert.deepEqual(
    left.map((p) => p.skill.scenario),
    ['shelf'],
    'the same brief and the same question are both left out',
  );
  writeFileSync(join(dir, 'torn-key.json'), 'not json');
  assert.throws(() => shownBefore(dir), /torn-key\.json doesn’t parse, so what its page showed can’t be left out/);
  assert.deepEqual(shownBefore(join(dir, 'nowhere')).pages, []);
});

test('#995 a run with no first picture isn’t saved as one, so a later reading can still find it', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pb-backfill-'));
  t.after(() => rmSync(dir, { recursive: true }));
  mkdirSync(join(dir, 'data'));
  mkdirSync(join(dir, 'shots'));
  const add = (id, kind, extra) => ({ type: 'item.add', data: { threadId: 'th_1', item: { id, kind, at: 1, ...extra } } });
  const events = [add('it_1', 'user', { text: 'Which?' }), add('it_3', 'block', { block: { id: 'subs', type: 'app', fallback: 'Six to cancel.' } })];
  writeFileSync(join(dir, 'data', 'events-1.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  writeFileSync(join(dir, 'report.md'), '## Visual verdicts\n\n| 2 | I3 | landed |\n');
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ scenario: 'subs' }));
  const onDisk = () => JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
  assert.deepEqual(await pictureOfRun(dir), { skipped: 'no screenshot of the agent’s app' });
  assert.equal('firstPicture' in onDisk(), false);
  writeFileSync(join(dir, 'shots', '01-I3.png'), 'png');
  assert.equal((await pictureOfRun(dir)).shot, 'shots/01-I3.png');
  assert.equal(onDisk().firstPicture.shot, 'shots/01-I3.png', 'saved once it has one');
  // A skip an earlier version saved is read again too.
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ scenario: 'subs', firstPicture: { skipped: 'old' } }));
  assert.equal((await pictureOfRun(dir)).shot, 'shots/01-I3.png');
});
