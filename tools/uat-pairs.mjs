// #995’s side-by-side judge, over runs: picture against picture, a scenario with Postbox’s skill against its `-base`
// twin, on the first picture of each and the sentence it was meant to say. It builds the blind page the maintainer
// calibrates the judge on, asks the judge about the same pairs, and reports their agreement. Reading the runs costs
// nothing; each judged pair is one model call, about $0.05.
//
//   node tools/uat-pairs.mjs build --out <folder> [--pairs 20]   the page, and <folder>-key.json with the judge’s picks
//   node tools/uat-pairs.mjs judge --out <folder> [--pairs 40]   the judge’s picks only, with no page, repeats allowed
//   node tools/uat-pairs.mjs rate <folder>                       how often the judge preferred the skill’s picture
//   node tools/uat-pairs.mjs agree <folder> <picks.json>         the judge’s agreement with the maintainer’s picks

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { agreement, arenaPairs, calibrationPage, judgeIntoKey, shownBefore, twinPairs } from './uat/calibration.mjs';
import { pictureOfRun } from './uat/pairs-backfill.mjs';
import { runsRoot } from './uat/runs.mjs';
import { parseScenario } from './uat/scenario.mjs';
import { firstSentence, judgePair } from './uat/side-by-side.mjs';
import { askOnce } from './uat/tester.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCENARIOS = join(ROOT, 'tests', 'uat', 'e2e', 'scenarios');
const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: { out: { type: 'string' }, pairs: { type: 'string', default: '20' }, 'judge-model': { type: 'string', default: 'claude-sonnet-5-5' } },
});
const [command, ...args] = positionals;
const pct = (x) => (x === null ? '–' : `${Math.round(x * 100)}%`);
const personaOf = (scenario) => parseScenario(readFileSync(join(SCENARIOS, `${scenario}.md`), 'utf8')).persona;

/** Every finished run of a scenario that has a `-base` twin, with its first picture. */
async function twinRuns() {
  const root = runsRoot({ root: ROOT });
  const scenarioOf = (dir) => (existsSync(join(dir, 'run.json')) ? JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')).scenario : null);
  const named = readdirSync(root).map((run) => ({ run, dir: join(root, run), scenario: scenarioOf(join(root, run)) }));
  const names = new Set(named.map((r) => r.scenario));
  const twinned = (s) => s && existsSync(join(SCENARIOS, `${s}.md`)) && (names.has(`${s}-base`) || (s.endsWith('-base') && names.has(s.slice(0, -5))));
  const out = [];
  for (const r of named.filter((x) => twinned(x.scenario) && existsSync(join(x.dir, 'report.md')))) {
    const picture = await pictureOfRun(r.dir);
    if (!picture.skipped) out.push({ ...r, picture });
  }
  return out;
}

/**
 * Asks the judge about each pair, as the page shows it. For a person (`build`), the pairs repeat no brief, question or
 * screenshot, on this page or an earlier one in the folder above it, and the page is written; for the judge alone (`judge`), pairs may repeat and there’s no page.
 * @param {{ person: boolean }} o
 */
async function build({ person }) {
  if (!opt.out) throw new Error(`${command} needs --out <folder>.`);
  const out = resolve(opt.out);
  // A scenario’s question can change between runs: a pair compares answers to the same one.
  const twins = twinPairs(await twinRuns(), Number.POSITIVE_INFINITY).filter((p) => p.skill.picture.question === p.base.picture.question);
  const earlier = person ? shownBefore(dirname(out)) : { seen: new Set(), pages: [] };
  const chosen = (person ? arenaPairs(twins, earlier.seen) : twins).slice(0, Number(opt.pairs));
  if (person && !chosen.length) {
    const shownOn = earlier.pages.length ? ` Already shown on: ${earlier.pages.join(', ')}.` : '';
    throw new Error(`No pair is left that a person hasn’t seen.${shownOn} A repeat needs a reason the page states, and the maintainer’s OK.`);
  }
  if (earlier.pages.length) console.log(`Left out every brief, question and run shown on: ${earlier.pages.join(', ')}.`);
  const shown = chosen.map((p) => {
    const skillAs = Math.random() < 0.5 ? 'A' : 'B';
    // A derived sentence saved before it was cut to 16 words is cut here, as one derived now would be.
    const intentOf = (pic) => (pic.intentFrom === 'fallback' ? firstSentence(pic.intent) : pic.intent);
    const side = (r) => ({ ...r.picture, intent: intentOf(r.picture), file: join(r.dir, r.picture.shot) });
    const sides = skillAs === 'A' ? [side(p.skill), side(p.base)] : [side(p.base), side(p.skill)];
    return { persona: personaOf(p.skill.scenario), question: p.skill.picture.question, sides, skillAs, p };
  });
  calibrationPage(shown, out, { page: person });
  const key = shown.map((s, i) => ({
    n: i + 1,
    skillAs: s.skillAs,
    skill: s.p.skill.run,
    base: s.p.base.run,
    question: s.question,
    person,
    judge: null,
    cost: 0,
  }));
  const { spent, failed } = await judgeIntoKey(key, `${out}-key.json`, ({ n }) => {
    const s = shown[n - 1];
    return judgePair({ persona: s.persona, question: s.question, sides: s.sides, model: opt['judge-model'], ask: askOnce });
  });
  const where = person ? join(out, 'index.html') : out;
  const noPick = failed ? ` The judge gave no pick on ${failed}; the key says why.` : '';
  console.log(`${key.length} pairs in ${where}; the key, with the judge’s picks, is in ${out}-key.json. Spent $${spent.toFixed(2)}.${noPick}`);
}

async function main() {
  if (command === 'build' || command === 'judge') return build({ person: command === 'build' });
  if (command === 'rate') {
    const key = JSON.parse(readFileSync(`${resolve(args[0])}-key.json`, 'utf8'));
    const a = agreement(key, { picks: key.map((k) => ({ n: k.n, pick: k.judge?.pick ?? null })) });
    console.log(
      `${a.pairs} pairs: the judge preferred the skill’s picture in ${a.judge.skill} (${pct(a.pairs ? a.judge.skill / a.pairs : null)}), the baseline’s in ${a.judge.base}, neither in ${a.judge.tie}. It counts once its agreement with the maintainer is reported.`,
    );
    return;
  }
  if (command === 'agree') {
    const [folder, picks] = args;
    const key = JSON.parse(readFileSync(`${resolve(folder)}-key.json`, 'utf8'));
    const a = agreement(key, JSON.parse(readFileSync(resolve(picks), 'utf8')));
    const k = a.kappa === null ? '–' : a.kappa.toFixed(2);
    console.log(
      `${a.pairs} pairs: the judge picked as the maintainer did in ${a.same} (${pct(a.observed)}), Cohen’s κ ${k}. The maintainer preferred the skill’s picture ${a.person.skill}, the baseline’s ${a.person.base}, neither ${a.person.tie}; the judge ${a.judge.skill}, ${a.judge.base} and ${a.judge.tie}.`,
    );
    return;
  }
  throw new Error('Say build, judge, rate or agree (see the top of tools/uat-pairs.mjs).');
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
