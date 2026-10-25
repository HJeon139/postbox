// #290: a run’s budget, --max-cost (tools/uat/budget.mjs). The fixture is the longresearch run of 24 October’s recorded
// streams, cut to their init and result events (tests/fixtures/uat/longresearch-results.json): an outside watchdog
// stopped that run with SIGINT, so it wrote no report. Its turns are replayed on node:test’s mock timers, each one
// working from its stream’s start for its result’s duration_ms and reporting its cost when it ends.
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AFTER_RUN_USD, AGENT_TURN_USD, budgetNote, parseMaxCost, runBudget, TESTER_STEP_USD } from '../tools/uat/budget.mjs';
import { streamResults } from '../tools/uat/cost.mjs';
import { writeReport } from '../tools/uat/report.mjs';
import { watchBudget } from '../tools/uat/turns.mjs';

const fixture = JSON.parse(readFileSync(new URL('fixtures/uat/longresearch-results.json', import.meta.url), 'utf8'));
const turns = fixture.streams.map((s) => ({ ...s, ms: s.events.find((e) => e.type === 'result').duration_ms }));

test('--max-cost is read where it enters, and the cap is split before the run starts', () => {
  assert.equal(parseMaxCost(undefined), null);
  assert.equal(parseMaxCost('12.5'), 12.5);
  for (const bad of ['', 'ten', '0', '-3']) assert.throws(() => parseMaxCost(bad), /--max-cost takes a number of dollars above 0/);
  // The tester’s share is its --budget; the verifier and telemetry get theirs; the agents the rest.
  const b = runBudget({ cap: 10, testerShare: 2 });
  assert.deepEqual(b.summary()?.shares, { agents: 10 - 2 - AFTER_RUN_USD, tester: 2, afterRun: AFTER_RUN_USD });
  // A cap that can’t hold the tester’s share, the reserve and one agent turn is refused before anything starts.
  assert.throws(
    () => runBudget({ cap: 8, testerShare: 8 }),
    /leaves the agents \$0\.00 after the tester’s \$8\.00 \(--budget\).*Raise --max-cost, or lower --budget/,
  );
  assert.throws(() => runBudget({ cap: 2 + AFTER_RUN_USD + AGENT_TURN_USD - 0.01, testerShare: 2 }), /less than the \$1\.00 an agent turn is reserved/);
});

test('without --max-cost, nothing is reserved, checked or stopped', () => {
  const b = runBudget({ cap: null, testerShare: 8 });
  assert.equal(b.on, false);
  b.track({ streams: () => fixture.streams, tester: { spent: 99 } });
  assert.equal(b.beforeStep({ step: 40, working: 3 }), null);
  assert.deepEqual(b.duringTurns([{ id: 'researcher' }, { id: 'critic' }]), []);
  assert.equal(watchBudget({ budget: b, api: async () => assert.fail('no watch'), threadsUnderTest: () => [], stop: async () => {} })(), undefined);
  assert.equal(b.verifier(), undefined, 'the verifier keeps askOnce');
  assert.equal(b.summary(), null);
  assert.equal(budgetNote(b.summary()), '');
});

test('replayed step by step, the run takes no step whose agent turn could pass the agents’ share', () => {
  // $4.50: the tester’s $1.50, $1 after the run, and $2 for the agents. Each recorded turn is one step’s.
  const b = runBudget({ cap: 4.5, testerShare: 1.5 });
  const tester = { spent: 0 };
  let shown = [];
  b.track({ streams: () => shown, tester });
  let step = 1;
  for (; step <= turns.length; step++) {
    if (b.beforeStep({ step, working: 0 })) break;
    tester.spent += 0.01;
    shown = turns.slice(0, step);
  }
  const s = b.summary();
  assert.equal(step, 20, 'it stops before the 20th turn');
  assert.equal(s?.spent.agents, 1.71);
  // The largest turn so far ($0.33, @critic’s first) would have taken the agents past their $2.
  assert.equal(s?.largest.turn, 0.33);
  assert.ok((s?.spent.agents ?? 0) + (s?.largest.turn ?? 0) > 2);
  assert.deepEqual(
    { ...s?.stopped, at: null },
    {
      step: 20,
      during: false,
      at: null,
      why: 'the agents have spent $1.71 of their $2.00, and an agent turn reserves $0.33 (the largest turn so far).',
    },
  );
  assert.ok((s?.spent.total ?? 0) <= 4.5);
  assert.deepEqual(s?.spent.byAgent, { researcher: 1.14, critic: 0.57 });
});

test('the tester takes no step once its next one could pass its share', () => {
  const b = runBudget({ cap: 5, testerShare: 1 });
  const tester = { spent: 0 };
  b.track({ streams: () => [], tester });
  // Before its first step, a step reserves TESTER_STEP_USD; then its largest so far.
  assert.equal(b.beforeStep({ step: 1, working: 0 }), null);
  tester.spent = 0.3;
  assert.equal(b.beforeStep({ step: 2, working: 0 }), null);
  tester.spent = 0.7;
  assert.match(
    String(b.beforeStep({ step: 3, working: 0 })),
    /the tester has spent \$0\.70 of its \$1\.00, and a step reserves \$0\.40 \(its largest so far\)/,
  );
  assert.equal(b.summary()?.stopped?.step, 3);
  assert.equal(TESTER_STEP_USD, 0.5);
});

test('once the run has stopped at its budget, a turn at work that fits may finish, and any that starts after is stopped', () => {
  const b = runBudget({ cap: 4.5, testerShare: 1.5 });
  b.track({ streams: () => turns.slice(0, 18), tester: { spent: 0.2 } });
  assert.ok(b.beforeStep({ step: 19, working: 1 }), 'stopped before step 19: with @researcher at work, two turns don’t fit');
  const researcher = { id: 'se_researcher' };
  const critic = { id: 'se_critic' };
  assert.deepEqual(b.duringTurns([researcher]), [], '@researcher’s turn fits, and may finish');
  // @critic, woken by that turn, starts while it runs: a new turn, stopped.
  assert.deepEqual(b.duringTurns([researcher, critic]), ['se_critic']);
  assert.deepEqual(b.duringTurns([]), []);
  // @researcher’s next turn is a new one too.
  assert.deepEqual(b.duringTurns([researcher]), ['se_researcher']);
});

test('past the budget, the newest turns at work are stopped until the rest fit', () => {
  // $2.40 for the agents, $1.17 spent and turns reserving $0.33: three fit, not four.
  const b = runBudget({ cap: 3.4, testerShare: 0 });
  b.track({ streams: () => turns.slice(0, 9), tester: { spent: 0 } });
  const at = (id) => ({ id });
  assert.deepEqual(b.duringTurns([at('a'), at('b')]), []);
  assert.deepEqual(b.duringTurns([at('a'), at('b'), at('c')]), []);
  assert.deepEqual(b.duringTurns([at('a'), at('b'), at('c'), at('d'), at('e')]), ['d', 'e']);
  assert.equal(b.stopped?.during, true);
  assert.match(b.stopped?.why ?? '', /5 agent turns reserve \$1\.67/);
});

test('a turn that ended without reporting its cost is charged a turn’s reservation', () => {
  // As the turns the runner stopped in the remotehosts runs of 24 October: an init, and no result.
  const stopped = { handle: 'critic', started: turns[9].started + 1, events: [{ type: 'system', subtype: 'init', session_id: 'x' }] };
  const b = runBudget({ cap: 5, testerShare: 1 });
  b.track({ streams: () => [...turns.slice(0, 9), stopped], tester: { spent: 0 } });
  // At work, it’s reserved like any turn at work; once nothing works, it’s charged the largest turn, $0.33.
  assert.equal(b.agentsOver(1, 1), null);
  const s = b.summary();
  assert.deepEqual(s?.spent.unreported, { turns: 1, usd: 0.33 });
  assert.equal(s?.spent.agents, 1.51);
  assert.match(budgetNote(s), /agents \$1\.51 \(@researcher \$0\.84, @critic \$0\.33, \$0\.33 estimated for a turn stopped before reporting\)/);
});

test('each verifier call is capped at what’s left of the whole cap, and its cost is counted', async () => {
  const b = runBudget({ cap: 5, testerShare: 1 });
  const tester = { spent: 0.8 };
  b.track({ streams: () => turns.slice(0, 9), tester });
  const asked = [];
  const ask = b.verifier(async (args) => {
    asked.push(args.budgetUsd);
    return { value: { results: [] }, cost: 0.42 };
  });
  await ask({ prompt: 'x' });
  // $5 less the agents’ $1.17 and the tester’s $0.80.
  assert.equal(Math.round(asked[0] * 100) / 100, 2);
  b.spend('telemetry', 0.01);
  b.spend('telemetry', null);
  const s = b.summary();
  assert.deepEqual([s?.spent.verifier, s?.spent.telemetry, s?.spent.total], [0.42, 0.01, 2.4]);
  // A call that fails spent too, and is counted: the next call’s cap is what’s left after it.
  const failing = b.verifier(async (args) => {
    asked.push(args.budgetUsd);
    throw Object.assign(new Error('Reached the maximum budget'), { cost: 1.5 });
  });
  await assert.rejects(failing({}), /maximum budget/);
  await ask({});
  assert.equal(Math.round(asked[2] * 100) / 100, 1.1);
  assert.equal(b.summary()?.spent.verifier, 2.34);
  const broke = runBudget({ cap: 3, testerShare: 0 });
  broke.track({ streams: () => fixture.streams, tester: { spent: 1 } });
  await assert.rejects(broke.verifier(async () => ({ cost: 0 }))({}), /\$0\.06 left, too little to verify\. Verify later with --recheck <run> --verify yes/);
});

/**
 * Postbox’s state while the recorded turns play from turn `from` on, the fake clock starting at its start: an agent
 * works while one of its turns covers the clock, and reports the turn’s cost when it ends. A stopped turn reports
 * nothing. Sessions are named for their agents.
 */
function replay(from) {
  const at = (s) => s.started - turns[from].started;
  /** @type {Set<number>} */
  const stopped = new Set();
  const live = () =>
    turns.map((_, i) => i).filter((i) => i >= from && !stopped.has(i) && at(turns[i]) <= Date.now() && Date.now() < at(turns[i]) + turns[i].ms);
  const shown = () =>
    turns
      .filter((s, i) => i < from || (at(s) <= Date.now() && (stopped.has(i) || at(s) + s.ms <= Date.now())))
      .map((s, i) => (stopped.has(i) ? { ...s, events: [] } : s));
  const api = async () => {
    const busy = live().map((i) => turns[i].handle);
    const sessions = Object.fromEntries(['researcher', 'critic'].map((h) => [h, { id: h, handle: h, state: busy.includes(h) ? 'tool' : 'idle' }]));
    return { state: { threads: { th_main: { id: 'th_main', members: ['researcher', 'critic'] } }, sessions, apps: {}, items: { th_main: [] } } };
  };
  /** @type {{ at: number, turn: number }[]} */
  const stops = [];
  const stop = async (id) => {
    for (const i of live())
      if (turns[i].handle === id) {
        stopped.add(i);
        stops.push({ at: Date.now(), turn: i });
      }
  };
  return { api, stop, stops, shown, at };
}

async function onFakeClock(t, ms, work) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  try {
    const out = work();
    for (let n = 0; n < ms; n += 250) {
      for (let i = 0; i < 5; i++) await new Promise(setImmediate);
      t.mock.timers.tick(250);
    }
    for (let i = 0; i < 5; i++) await new Promise(setImmediate);
    return out;
  } finally {
    t.mock.timers.reset();
  }
}

test('while agents wake each other, the turn that could pass the budget is stopped as it starts, whatever the run is doing', async (t) => {
  // @researcher’s turn 9 and @critic’s turn 10 started 1.5 s apart, with no tester step between. With $1.60 for the
  // agents, one turn fits ($1.17 spent, and a turn reserves $0.33), and two don’t. The watch runs while the tester
  // thinks, or a wait waits, as well as between steps.
  const { api, stop, stops, shown, at } = replay(9);
  const b = runBudget({ cap: 1.6 + AFTER_RUN_USD, testerShare: 0, now: () => Date.now() });
  const lines = [];
  b.track({ streams: shown, tester: { spent: 0 }, log: (l) => lines.push(l) });
  const seen = await onFakeClock(t, 40_000, () => {
    const unwatch = watchBudget({ budget: b, api, threadsUnderTest: () => ['th_main'], stop, log: (l) => lines.push(l) });
    return { unwatch, summaryAt: () => b.summary() };
  });
  seen.unwatch();
  assert.equal(stops[0]?.turn, 10, '@critic’s turn is stopped, the newest');
  assert.ok(stops[0].at - at(turns[10]) <= 1500, `as it starts (${stops[0].at - at(turns[10])} ms after)`);
  assert.match(b.stopped?.why ?? '', /^the agents have spent \$1\.17 of their \$1\.60, and 2 agent turns reserve \$0\.67 \(the largest turn so far\)\.$/);
  assert.ok(
    lines.some((l) => /^Stopped at the run’s budget \(--max-cost \$2\.60\)/.test(l)),
    lines.join('\n'),
  );
  // @researcher’s turn, at work and within the budget, finished and was counted; the run had stopped, so the next
  // turn its reply started was stopped as it started.
  assert.equal(stops[1]?.turn, 11);
  assert.ok(stops[1].at - at(turns[11]) <= 1500);
  assert.equal(stops.length, 2);
  assert.ok(lines.some((l) => l === 'budget: stopping @critic’s turn'));
});

test('a run stopped at its budget still writes its report and findings, saying so and what each spent', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'uat-budget-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const b = runBudget({ cap: 4.5, testerShare: 1.5 });
  b.track({ streams: () => turns.slice(0, 19), tester: { spent: 0.2 } });
  b.beforeStep({ step: 20, working: 0 });
  const facts = { streams: turns.slice(0, 19), kiroStreams: [], agyStreams: [], state: null, probes: {}, samples: [], budget: b.summary() };
  const quiet = t.mock.method(console, 'log', () => {});
  await writeReport({
    dir,
    scenario: { title: 'Long research' },
    issues: [],
    findings: [],
    timeline: [],
    started: 0,
    tester: { spent: 0.2 },
    facts,
    logLines: [],
  });
  quiet.mock.restore();
  const md = readFileSync(join(dir, 'report.md'), 'utf8');
  assert.match(
    md,
    /Budget: \$4\.50 \(--max-cost\), of which it spent \$1\.91: agents \$1\.71 \(@researcher \$1\.14, @critic \$0\.57\), tester \$0\.20, verifier \$0\.00, telemetry \$0\.00\. \*\*It stopped at its budget\*\* before step 20: the agents have spent \$1\.71 of their \$2\.00/,
  );
  const saved = JSON.parse(readFileSync(join(dir, 'findings.json'), 'utf8'));
  assert.equal(saved.budget.stopped.step, 20);
  assert.equal(saved.budget.spent.total, 1.91);
});

test('the budget reads only the streams’ results, and reads a stream again only once it has grown', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'uat-budget-streams-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const [init, result] = fixture.streams[0].events;
  const file = join(dir, `${fixture.streams[0].started}-researcher.jsonl`);
  writeFileSync(file, `${JSON.stringify(init)}\n${JSON.stringify({ type: 'assistant', message: { content: [] } })}\n`);
  const read = streamResults(dir);
  const first = read();
  assert.deepEqual(first, [{ handle: 'researcher', started: fixture.streams[0].started, events: [] }]);
  assert.equal(read()[0], first[0], 'the same file, unchanged, isn’t read again');
  appendFileSync(file, `${JSON.stringify(result)}\n`);
  assert.deepEqual(read()[0].events, [result]);
});
