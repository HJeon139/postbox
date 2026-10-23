// Refits the UAT’s scale from every archived run: discovery per step, the share of a 20-step yield each cap keeps,
// how the findings were judged, what a step costs, and, for targeted runs, how often each trigger happened. It only
// reads the runs.
//
//   node tools/uat-stats.mjs                      the runs folder (POSTBOX_UAT_RUNS, or uat-runs/ in the main checkout)
//   node tools/uat-stats.mjs --runs a --runs b    other folders, together (a run in two of them counts once)

import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { readRuns, runsRoot } from './uat/runs.mjs';
import { report } from './uat/stats.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const { values: opt } = parseArgs({
  options: {
    runs: { type: 'string', multiple: true },
    resamples: { type: 'string', default: '2000' },
  },
});

const roots = opt.runs?.length ? opt.runs.map((r) => resolve(r)) : [runsRoot({ root: ROOT })];
const { runs, unfinished, unreadable } = readRuns(roots, { scenarios: join(ROOT, 'tests', 'uat', 'e2e', 'scenarios') });
console.log(report(runs, { roots, unfinished, unreadable, resamples: Math.max(100, Number(opt.resamples) || 2000) }).join('\n'));
