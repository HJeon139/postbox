// A run’s cost counts each agent turn and tester step once (tools/uat/cost.mjs). A result’s total_cost_usd is its Claude
// Code session’s running total, and agents and the tester resume their session every turn, so adding the totals
// counted every earlier turn again. The fixture is the longresearch run of 24 October’s recorded streams, cut to their
// init and result events (tests/fixtures/uat/longresearch-results.json): its two sessions ended at $1.37 and $0.57, and
// their totals added up to $17.64.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { codexTokens, uncosted } from '../tools/uat/cost.mjs';
import { writeReport } from '../tools/uat/report.mjs';
import { reportFacts, runRecord } from '../tools/uat/runs.mjs';
import { createTester } from '../tools/uat/tester.mjs';

const fixture = JSON.parse(readFileSync(new URL('fixtures/uat/longresearch-results.json', import.meta.url), 'utf8'));
const streams = fixture.streams;
const lastOf = (handle) =>
  streams
    .filter((s) => s.handle === handle)
    .at(-1)
    .events.find((e) => e.type === 'result').total_cost_usd;
const spent = lastOf('researcher') + lastOf('critic');
const round = (n) => Math.round(n * 100) / 100;

test('run.json counts each agent session’s spend once, not every running total', () => {
  const summed = streams.flatMap((s) => s.events).reduce((a, e) => a + (e.total_cost_usd ?? 0), 0);
  assert.equal(round(summed), 17.64, 'what adding the totals said');
  const r = runRecord({
    root: '/repo',
    dir: '/runs/2026-10-24T21-54-03-longresearch',
    scenario: { title: 'Long research', phases: [] },
    name: 'longresearch',
    opt: {},
    started: 0,
    steps: 12,
    cap: 15,
    tester: { spent: 0.3 },
    facts: { streams },
    coverage: [],
    now: 0,
    git: () => null,
  });
  assert.equal(r.cost.agents, round(spent));
  assert.equal(r.cost.agents, 1.94);
});

test('a run’s record names the harnesses whose cost isn’t in the agents’ dollars', () => {
  const r = runRecord({
    root: '/repo',
    dir: '/runs/2026-10-24T21-54-03-longresearch',
    scenario: { title: 'Long research', phases: [] },
    name: 'longresearch',
    opt: {},
    started: 0,
    steps: 12,
    cap: 15,
    tester: { spent: 0.3 },
    facts: { streams, codexStreams, agyStreams: [{ handle: 'developer', events: [] }] },
    coverage: [],
    now: 0,
    git: () => null,
  });
  assert.equal(r.cost.agents, round(spent));
  assert.deepEqual(r.cost, { agents: 1.94, tester: r.cost.tester, kiroCredits: null, noCostFrom: ['Codex', 'Antigravity'] });
});

test('the report’s usage line says what the agents spent', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'uat-cost-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const facts = { streams, kiroStreams: [], agyStreams: [], state: null, probes: {}, samples: [], agentModels: '@researcher claude-opus-5-5' };
  const quiet = t.mock.method(console, 'log', () => {});
  await writeReport({
    dir,
    scenario: { title: 'Long research' },
    issues: [],
    findings: [],
    timeline: [],
    started: 0,
    tester: { spent: 0.3 },
    facts,
    logLines: [],
  });
  quiet.mock.restore();
  assert.match(readFileSync(join(dir, 'report.md'), 'utf8'), /Usage: agents \$1\.94, tester \$0\.30\./);
});

// A run with agents on Codex, Kiro or Antigravity: only Claude Code reports dollars, so “agents $0.01” read as what
// all four cost (the inbox measurement of 16 November, #1399’s report).
const usage = (thread, input, output) => ({
  method: 'thread/tokenUsage/updated',
  params: { threadId: thread, tokenUsage: { total: { inputTokens: input, outputTokens: output } } },
});
const codexStreams = [
  { handle: 'critic', events: [usage('t1', 100, 10), usage('t1', 400, 30)] },
  { handle: 'critic', events: [usage('t1', 900, 60), usage('t2', 50, 5)] },
];

test('Codex’s tokens are each thread’s last total, added up: a thread’s count runs on from turn to turn', () => {
  assert.equal(codexTokens(codexStreams), 960 + 55);
  assert.equal(codexTokens([]), 0);
  // The streams come in the order their files are read, which isn’t the order the turns ran: a thread’s total only
  // grows, so its largest is its last, whichever turn is read first.
  assert.equal(codexTokens([...codexStreams].reverse()), 960 + 55);
});

test('the harnesses a run used that report no cost are named, and a run on Claude Code alone names none', () => {
  assert.deepEqual(uncosted({ codexStreams, kiroStreams: [], agyStreams: [{ handle: 'developer', events: [] }] }), ['Codex', 'Antigravity']);
  assert.deepEqual(uncosted({ streams, kiroStreams: [], agyStreams: [] }), []);
});

test('the report’s usage line says the agents’ dollars are Claude Code’s alone when other harnesses ran', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'uat-cost-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const facts = { streams, codexStreams, kiroStreams: [], agyStreams: [], state: null, probes: {}, samples: [], agentModels: '@researcher claude-opus-5-5' };
  const quiet = t.mock.method(console, 'log', () => {});
  await writeReport({ dir, scenario: { title: 'Mixed' }, issues: [], findings: [], timeline: [], started: 0, tester: { spent: 0.3 }, facts, logLines: [] });
  quiet.mock.restore();
  const line = readFileSync(join(dir, 'report.md'), 'utf8');
  assert.ok(line.includes('Usage: agents $1.94 on Claude Code alone (Codex reports no cost: 1,015 Codex tokens), tester $0.30.'), line.slice(0, 400));
});

test('a report’s length and cost are read back whatever its usage line holds', () => {
  const run = 'Run on 2026-11-16 01:03, 6 min, 14 steps.';
  const read = (/** @type {string} */ usageLine) => {
    const f = reportFacts(`${run} ${usageLine}`);
    return [f.steps, f.agentsUsd, f.kiroCredits, f.testerUsd];
  };
  // As the report wrote it before: with Antigravity’s tokens it wasn’t read back at all.
  assert.deepEqual(read('Usage: agents $0.01 and 0.15 Kiro credits and 83,713 Antigravity tokens, tester $0.16.'), [14, 0.01, 0.15, 0.16]);
  assert.deepEqual(
    read(
      'Usage: agents $0.01 on Claude Code alone (Codex, Kiro and Antigravity report no cost: 1,015 Codex tokens, 0.15 Kiro credits, 83,713 Antigravity tokens), tester $0.16.',
    ),
    [14, 0.01, 0.15, 0.16],
  );
  assert.deepEqual(read('Usage: agents $28.59, tester $1.50.'), [14, 28.59, null, 1.5]);
});

/** A fake claude CLI for the tester: each step answers with the session’s running total, as a resumed session does. */
function fakeClaude(totals) {
  const calls = [];
  const run = (_bin, args) => {
    calls.push(args);
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
    const total = totals[calls.length - 1];
    child.stdin = {
      end: () =>
        setImmediate(() => {
          const answer = { assessment: 'ok', findings: [], action: { type: 'wait', seconds: 5 } };
          child.stdout.emit(
            'data',
            JSON.stringify({ type: 'result', is_error: false, session_id: 'tester-session', total_cost_usd: total, structured_output: answer }),
          );
          child.emit('close', 0);
        }),
    };
    return child;
  };
  return { run, calls };
}

test('the tester’s spend is its session’s running total, and its next step’s cap is what’s left of its budget', async (t) => {
  // Its sign-in comes from no settings at all: the test never reads the person’s.
  const home = mkdtempSync(join(tmpdir(), 'uat-cost-home-'));
  const before = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = home;
  t.after(() => {
    if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = before;
    rmSync(home, { recursive: true, force: true });
  });
  const claude = fakeClaude([0.05, 0.11, 0.18]);
  const tester = createTester({ cwd: home, model: 'claude-sonnet-5-5', budgetUsd: 1, log: () => {}, run: claude.run });
  for (let i = 0; i < 3; i++) await tester.step('Step', 'System');
  assert.equal(tester.spent, 0.18, 'not 0.05 + 0.11 + 0.18');
  const cap = (args) => Number(args[args.indexOf('--max-budget-usd') + 1]);
  assert.deepEqual(claude.calls.map(cap), [1, 0.95, 0.89]);
});
