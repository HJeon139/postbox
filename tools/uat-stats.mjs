// Refits the UAT’s scale from every archived run: discovery per step, the share of a 20-step yield each cap keeps,
// how the findings were judged, what a step costs, for targeted runs how often each trigger happened, and which
// issues the runs caught again (recurrence). It only reads the runs, and the issues’ states through gh.
//
//   node tools/uat-stats.mjs                      the runs folder (POSTBOX_UAT_RUNS, or uat-runs/ in the main checkout)
//   node tools/uat-stats.mjs --runs a --runs b    other folders, together (a run in two of them counts once)

import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { readRuns, runsRoot } from './uat/runs.mjs';
import { recurrence, recurrenceTable, report } from './uat/stats.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const { values: opt } = parseArgs({
  options: {
    runs: { type: 'string', multiple: true },
    resamples: { type: 'string', default: '2000' },
  },
});

const roots = opt.runs?.length ? opt.runs.map((r) => resolve(r)) : [runsRoot({ root: ROOT })];
const { runs, unfinished, unreadable } = readRuns(roots, { scenarios: join(ROOT, 'tests', 'uat', 'e2e', 'scenarios') });
// Each issue’s state, closing time and priority label, for the recurrence table; without gh, the table says “?”.
const gh = spawnSync('gh', ['issue', 'list', '--state', 'all', '--limit', '1000', '--json', 'number,state,closedAt,labels'], { cwd: ROOT, encoding: 'utf8' });
const issues = new Map(
  (gh.status === 0 ? JSON.parse(gh.stdout) : []).map((i) => [
    i.number,
    { state: i.state, closedAt: i.closedAt || null, priority: i.labels.map((l) => l.name).find((n) => /^P\d$/.test(n)) ?? null },
  ]),
);
console.log(
  [
    ...report(runs, { roots, unfinished, unreadable, resamples: Math.max(100, Number(opt.resamples) || 2000) }),
    '',
    ...recurrenceTable(recurrence(runs, issues)),
    ...(gh.status === 0 ? [] : ['  (The gh CLI isn’t available or signed in, so issue states and priorities are “?”.)']),
  ].join('\n'),
);
