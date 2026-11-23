// #1674: the Agent SDK reports dollars as Claude Code does, but a run counted only Claude Code’s streams (streams/),
// not the Agent SDK’s (streams/sdk/). The fixture is the wikisearch run of 23 November on the Agent SDK, its seven
// turns cut to their init and result events (tests/fixtures/uat/wikisearch-sdk-results.json): its one session ended at
// $1.31, and its run.json said agents $0.00 and byAgent {}, so its --max-cost never saw the agent.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runBudget } from '../tools/uat/budget.mjs';
import { dollarFolders, streamResults } from '../tools/uat/cost.mjs';
import { writeReport } from '../tools/uat/report.mjs';
import { runRecord } from '../tools/uat/runs.mjs';

const fixture = JSON.parse(readFileSync(new URL('fixtures/uat/wikisearch-sdk-results.json', import.meta.url), 'utf8'));
const sdkStreams = fixture.streams;
const spent = Math.round(sdkStreams.at(-1).events.at(-1).total_cost_usd * 100) / 100;

/** A run folder with the fixture’s turns where the Agent SDK adapter records them, and none in streams/. */
function runFolder(t) {
  const dir = mkdtempSync(join(tmpdir(), 'uat-sdk-cost-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'streams', 'sdk'), { recursive: true });
  for (const s of sdkStreams)
    writeFileSync(join(dir, 'streams', 'sdk', `${s.started}-${s.handle}.jsonl`), `${s.events.map((e) => JSON.stringify(e)).join('\n')}\n`);
  return dir;
}

test('the fixture’s session only grows, to the $1.31 the run didn’t count', () => {
  const totals = sdkStreams.map((s) => s.events.find((e) => e.type === 'result').total_cost_usd);
  assert.deepEqual(
    totals,
    [...totals].sort((a, b) => a - b),
  );
  assert.equal(spent, 1.31);
});

test('the budget’s live read counts the Agent SDK’s turns, in its total and by agent', (t) => {
  const dir = runFolder(t);
  const budget = runBudget({ cap: 9, testerShare: 2 });
  budget.track({ streams: streamResults(...dollarFolders({ streams: join(dir, 'streams'), sdkStreams: join(dir, 'streams', 'sdk') })), tester: { spent: 0 } });
  assert.equal(Math.round(budget.spent().agents * 100) / 100, spent);
  const summary = budget.summary();
  assert.equal(summary?.spent.agents, spent);
  assert.deepEqual(summary?.spent.byAgent, { researcher: spent });
  // A folder no turn has written to yet (a backend no agent ran on) reads as no turns, not an error.
  assert.equal(streamResults(join(dir, 'streams', 'none'), join(dir, 'streams', 'sdk'))().length, sdkStreams.length);
});

test('a run’s record counts the Agent SDK’s dollars in the agents’ cost', () => {
  const r = runRecord({
    root: '/repo',
    dir: `/runs/${fixture.run}`,
    scenario: { title: 'Wiki search', phases: [] },
    name: 'wikisearch',
    opt: {},
    started: 0,
    steps: 8,
    cap: 8,
    tester: { spent: 0.17 },
    facts: { streams: [], sdkStreams },
    coverage: [],
    now: 0,
    git: () => null,
  });
  assert.equal(r.cost.agents, spent);
  // The model the agent ran, from its own streams, not the runner’s --agent-model.
  assert.equal(r.agents.model, 'claude-opus-5-5');
});

test('the report’s usage line counts the Agent SDK’s dollars', async (t) => {
  const dir = runFolder(t);
  const facts = { streams: [], sdkStreams, kiroStreams: [], agyStreams: [], state: null, probes: {}, samples: [] };
  const quiet = t.mock.method(console, 'log', () => {});
  await writeReport({
    dir,
    scenario: { title: 'Wiki search' },
    issues: [],
    findings: [],
    timeline: [],
    started: 0,
    tester: { spent: 0.17 },
    facts,
    logLines: [],
  });
  quiet.mock.restore();
  assert.match(readFileSync(join(dir, 'report.md'), 'utf8'), /Usage: agents \$1\.31, tester \$0\.17\./);
});
