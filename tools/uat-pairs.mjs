// #995’s side-by-side judge, over runs: picture against picture, a scenario with Postbox’s skill against its `-base`
// twin, on the first picture of each and the sentence it was meant to say. It builds the blind page the maintainer
// calibrates the judge on, asks the judge about the same pairs, and reports their agreement. Reading the runs costs
// nothing; each judged pair is one model call, about $0.05.
//
//   node tools/uat-pairs.mjs build --out <folder> [--pairs 20]   the page, and <folder>-key.json with the judge’s picks
//   node tools/uat-pairs.mjs rate <folder>                       how often the judge preferred the skill’s picture
//   node tools/uat-pairs.mjs agree <folder> <picks.json>         the judge’s agreement with the maintainer’s picks

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { agreement, calibrationPage, twinPairs } from './uat/calibration.mjs';
import { pictureOfRun } from './uat/pairs-backfill.mjs';
import { runsRoot } from './uat/runs.mjs';
import { parseScenario } from './uat/scenario.mjs';
import { judgePair } from './uat/side-by-side.mjs';
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

/** Builds the page and asks the judge about each pair, as it’s shown there. */
async function build() {
  if (!opt.out) throw new Error('build needs --out <folder>.');
  const out = resolve(opt.out);
  // A scenario’s question can change between runs: a pair compares answers to the same one.
  const chosen = twinPairs(await twinRuns(), Number.POSITIVE_INFINITY)
    .filter((p) => p.skill.picture.question === p.base.picture.question)
    .slice(0, Number(opt.pairs));
  const shown = chosen.map((p) => {
    const skillAs = Math.random() < 0.5 ? 'A' : 'B';
    const side = (r) => ({ ...r.picture, file: join(r.dir, r.picture.shot) });
    const sides = skillAs === 'A' ? [side(p.skill), side(p.base)] : [side(p.base), side(p.skill)];
    return { persona: personaOf(p.skill.scenario), question: p.skill.picture.question, sides, skillAs, p };
  });
  calibrationPage(shown, out);
  const key = [];
  let spent = 0;
  for (const [i, s] of shown.entries()) {
    const files = [`${i + 1}-a.png`, `${i + 1}-b.png`];
    const sides = s.sides.map((x, j) => ({ ...x, file: files[j] }));
    const judge = await judgePair({ persona: s.persona, question: s.question, sides, cwd: out, model: opt['judge-model'], ask: askOnce });
    spent += judge.cost;
    key.push({ n: i + 1, skillAs: s.skillAs, skill: s.p.skill.run, base: s.p.base.run, judge: { pick: judge.pick, why: judge.why } });
  }
  writeFileSync(`${out}-key.json`, `${JSON.stringify(key, null, 2)}\n`);
  console.log(`${key.length} pairs in ${join(out, 'index.html')}; the key, with the judge’s picks, is in ${out}-key.json. Spent $${spent.toFixed(2)}.`);
}

async function main() {
  if (command === 'build') return build();
  if (command === 'rate') {
    const key = JSON.parse(readFileSync(`${resolve(args[0])}-key.json`, 'utf8'));
    const a = agreement(key, { picks: key.map((k) => ({ n: k.n, pick: k.judge.pick })) });
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
  throw new Error('Say build, rate or agree (see the top of tools/uat-pairs.mjs).');
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
