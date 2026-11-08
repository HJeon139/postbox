// #995’s side-by-side judge, over runs: its rate against #206’s bar, pairs for runs that finished before it, and its
// calibration against the maintainer’s blind picks. Pairs cost real usage: a words answer on the agent’s model and a
// judge’s call each, about $0.30 a pair.
//
//   node tools/uat-pairs.mjs rate [run…]                 the rate over these runs, or every run in the runs folder
//   node tools/uat-pairs.mjs backfill <run…>             a pair for each finished, judged run that has none
//   node tools/uat-pairs.mjs page --out <folder> <run…>  the blind page for the maintainer, and <folder>-key.json
//   node tools/uat-pairs.mjs agree <folder> <picks.json> the judge’s agreement with the maintainer’s picks

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { agreement, calibrationPage, pairOf } from './uat/calibration.mjs';
import { backfillPair } from './uat/pairs-backfill.mjs';
import { runsRoot } from './uat/runs.mjs';
import { parseScenario } from './uat/scenario.mjs';
import { BAR, pairRate } from './uat/side-by-side.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCENARIOS = join(ROOT, 'tests', 'uat', 'e2e', 'scenarios');
const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: { out: { type: 'string' }, 'judge-model': { type: 'string', default: 'claude-sonnet-5-5' } },
});
const [command, ...args] = positionals;
const root = runsRoot({ root: ROOT });
/** A run named by its folder, or by its name in the runs folder. @param {string} r */
const runDir = (r) => (existsSync(resolve(r)) ? resolve(r) : join(root, r));
const runJson = (dir) => (existsSync(join(dir, 'run.json')) ? JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')) : null);
/** Whether the rate meets #206’s bar, in words. @param {boolean|null} met */
function barSaid(met) {
  if (met === null) return 'no pairs';
  return met ? 'met' : 'not met';
}
const pct = (x) => (x === null ? '–' : `${Math.round(x * 100)}%`);

async function main() {
  if (command === 'rate') {
    const dirs = args.length ? args.map(runDir) : readdirSync(root).map((r) => join(root, r));
    const r = pairRate(dirs.map((d) => runJson(d)?.sideBySide).filter(Boolean));
    console.log(
      `${r.pairs} pairs: the picture preferred in ${r.picture} (${pct(r.rate)}), the words in ${r.words}, neither in ${r.tie}; ${r.skipped} runs had no pair. #206’s bar is ${BAR.wins} in ${BAR.of}: ${barSaid(r.meetsBar)}, by a judge whose agreement with the maintainer must be reported first.`,
    );
    return;
  }
  if (command === 'backfill') {
    const { askOnce } = await import('./uat/tester.mjs');
    let spent = 0;
    for (const dir of args.map(runDir)) {
      const pair = await backfillPair(dir, { scenarios: SCENARIOS, ask: askOnce, judgeModel: opt['judge-model'] });
      spent += (pair.cost?.words ?? 0) + (pair.cost?.judge ?? 0);
      console.log(`${basename(dir)}: ${pair.skipped ? `no pair (${pair.skipped})` : `preferred ${pair.pick}`}`);
    }
    console.log(`Spent $${spent.toFixed(2)}.`);
    return;
  }
  if (command === 'page') {
    if (!opt.out) throw new Error('page needs --out <folder>.');
    const pairs = args.map(runDir).flatMap((dir) => {
      const record = runJson(dir);
      if (!record?.sideBySide?.pick) return [];
      const persona = parseScenario(readFileSync(join(SCENARIOS, `${record.scenario}.md`), 'utf8')).persona;
      return [pairOf(dir, record, persona)];
    });
    const key = calibrationPage(pairs, { out: resolve(opt.out) });
    writeFileSync(`${resolve(opt.out)}-key.json`, `${JSON.stringify(key, null, 2)}\n`);
    console.log(`${pairs.length} pairs in ${join(resolve(opt.out), 'index.html')}; the key is in ${resolve(opt.out)}-key.json.`);
    return;
  }
  if (command === 'agree') {
    const [folder, picks] = args;
    const key = JSON.parse(readFileSync(`${resolve(folder)}-key.json`, 'utf8'));
    const a = agreement(key, JSON.parse(readFileSync(resolve(picks), 'utf8')));
    const k = a.kappa === null ? '–' : a.kappa.toFixed(2);
    console.log(
      `${a.pairs} pairs: the judge picked as the maintainer did in ${a.same} (${pct(a.observed)}), Cohen’s κ ${k}. The maintainer preferred the picture ${a.person.picture}, the words ${a.person.words}, neither ${a.person.tie}; the judge ${a.judge.picture}, ${a.judge.words} and ${a.judge.tie}.`,
    );
    return;
  }
  throw new Error('Say rate, backfill, page or agree (see the top of tools/uat-pairs.mjs).');
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
