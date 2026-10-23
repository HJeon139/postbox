import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { keepEvent } from '../tools/uat/history.mjs';
import { readRun, readRuns, reportFacts, runRecord, runsRoot, streamModel, writeJsonAtomic } from '../tools/uat/runs.mjs';
import { DEFAULT_STEPS, isTargeted, PHASE_STEPS, parseScenario, phaseCap, stepCap } from '../tools/uat/scenario.mjs';
import { costPerStep, curve, precision, rateOver, report, summarize, triggerCoverage, yieldShare } from '../tools/uat/stats.mjs';
import { SCHEMA, systemPrompt, VERIFY_SCHEMA } from '../tools/uat/tester.mjs';
import { coverageSection, GRACE, jobTimeline, phaseGoals, TRIGGERS, triggersFired, unknownTriggers } from '../tools/uat/triggers.mjs';
import { findFinding, mergePeopleVerdicts, normalVerdict, presetVerdicts, setVerdict, VERDICTS, verdictOf } from '../tools/uat/verdicts.mjs';
import { verdictCli } from '../tools/uat-verdict.mjs';

const scenarios = new URL('uat/e2e/scenarios/', import.meta.url);
const read = (name) => parseScenario(readFileSync(new URL(`${name}.md`, scenarios), 'utf8'));
const tmp = () => mkdtempSync(join(tmpdir(), 'postbox-uat-scale-'));

describe('how long a run is', () => {
  test('an exploratory run is 15 steps unless its scenario or --steps says otherwise', () => {
    const s = read('scifact');
    assert.equal(DEFAULT_STEPS, 15);
    assert.equal(isTargeted(s), false);
    assert.equal(stepCap(s), 15);
    assert.equal(stepCap(s, '30'), 30);
    assert.equal(stepCap(parseScenario('# T\n\n- steps: 12\n\nGo.\n\n## Phase 1\n\nDo it.\n')), 12);
    assert.equal(stepCap(parseScenario('# T\n\n- steps: 12\n\nGo.\n\n## Phase 1\n\nDo it.\n'), '20'), 20);
    // Not a count: said, not ignored.
    assert.throws(() => stepCap(s, 'many'), /--steps takes a whole number/);
    for (const p of s.phases) assert.equal(phaseCap(p), null);
  });

  test('a phase can name its triggers and its own cap, before its text; the tester doesn’t see those lines', () => {
    const s = parseScenario(
      '# T\n\nGo.\n\n## Phase 1: A\n\n- triggers: wake-full-text, repeated-block-id\n- steps: 5\n\nDo it.\n- a list item: stays\n\n## Phase 2: B\n\n- trigger: stale-answer\n\nThen this.\n',
    );
    assert.deepEqual(s.phases[0].triggers, ['wake-full-text', 'repeated-block-id']);
    assert.equal(s.phases[0].steps, 5);
    assert.equal(s.phases[0].text, 'Do it.\n- a list item: stays');
    assert.deepEqual(s.phases[1].triggers, ['stale-answer']);
    assert.equal(phaseCap(s.phases[1]), PHASE_STEPS);
    assert.equal(isTargeted(s), true);
    // A targeted run’s cap is its phases’ caps added up.
    assert.equal(stepCap(s), 5 + PHASE_STEPS);
  });

  test('the P0 scenario is targeted: each phase names the fixes’ triggers, all of which exist', () => {
    const s = read('p0');
    assert.equal(isTargeted(s), true);
    assert.deepEqual(unknownTriggers(s), []);
    assert.deepEqual(
      s.phases.map((p) => p.triggers),
      [['wake-full-text'], ['update-over-unread', 'stale-answer', 'repeated-block-id'], ['stop-keep-jobs', 'stop-jobs-too', 'send-now-job-running']],
    );
    assert.equal(stepCap(s), 28);
    // Phase 1 is short and sends only changes after the first round (the last P0 run rewrote 60-item lists, $191).
    assert.match(s.phases[0].text, /about 15 items/);
    assert.match(s.phases[0].text, /only what changed/);
    // Phase 2 causes #123 and #125 instead of hoping for a race.
    assert.match(s.phases[1].text, /answer the draft while it’s still working/);
    assert.match(s.phases[1].text, /same id/);
    assert.deepEqual(unknownTriggers(parseScenario('# T\n\n## P\n\n- triggers: nope\n\nx')), ['nope']);
  });
});

// ── Triggers ───────────────────────────────────────────────────────────────────────────────

const facts = (over = {}) => ({
  state: { threads: { t1: { id: 't1', kind: 'thread' }, side: { id: 'side', kind: 'side', parentId: 't1' } }, items: { t1: [], side: [] }, sessions: {} },
  threads: ['t1', 'side'],
  streams: [],
  events: [],
  probes: { stale: [], interrupts: [] },
  ...over,
});
const call = (name, input, result, isError = true, ts = '2026-10-23T05:00:00.000Z') => ({
  handle: 'researcher',
  events: [
    { type: 'assistant', timestamp: ts, message: { content: [{ type: 'tool_use', id: 'c1', name: `mcp__postbox__${name}`, input }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'c1', is_error: isError, content: [{ type: 'text', text: result }] }] } },
  ],
});
const session = (seq, id, over = {}) => ({ seq, type: 'session', data: { id, state: 'tool', finishedAt: null, updatedAt: seq, stopAsk: null, ...over } });

describe('triggers: what a targeted phase is there to cause', () => {
  test('#108: an allowed wake whose woken agent got the whole message, longer than the preview', () => {
    const text = `${'A long list of changes. '.repeat(20)}The end.`;
    const hop = {
      id: 'h1',
      kind: 'hop',
      status: 'allowed',
      from: 'critic',
      to: 'researcher',
      fromSessionId: 's2',
      reason: `${text.slice(0, 199)}…`,
      text,
      at: 1,
    };
    const got = (t) => facts({ state: { ...facts().state, items: { t1: [hop], side: [{ id: 'a', kind: 'agent', sessionId: 's2', text: t, at: 2 }] } } });
    assert.match(TRIGGERS['wake-full-text'].run(got(text))[0].evidence, /reached @researcher whole/);
    // Only the preview reached it: the defect, not the fix.
    assert.deepEqual(TRIGGERS['wake-full-text'].run(got(hop.reason)), []);
    // A short message never needed the fix.
    const short = { ...hop, text: 'Short.', reason: 'Short.' };
    assert.deepEqual(
      TRIGGERS['wake-full-text'].run(
        facts({ state: { ...facts().state, items: { t1: [short], side: [{ id: 'a', kind: 'agent', sessionId: 's2', text: 'Short.', at: 2 }] } } }),
      ),
      [],
    );
  });

  test('#123 and #125: Postbox’s refusals, read from the tool results in the agents’ streams', () => {
    const unread = call(
      'update_block',
      { block: { id: 'draft' } },
      'The update wasn’t applied. The person answered revision 2 of draft at 17:13: request_changes, 3 comments. Their answer stays on screen. It reaches you when this turn ends: read it, then update.',
    );
    const repeated = call('show_block', { block: { id: 'draft' } }, 'Block draft is already shown. Use update_block to change it, or pick a new id.');
    const f = facts({ streams: [unread, repeated] });
    const fired = triggersFired(f, ['update-over-unread', 'repeated-block-id', 'stale-answer']);
    assert.ok(fired['update-over-unread']);
    assert.equal(/** @type {any} */ (fired['update-over-unread']).at, Date.parse('2026-10-23T05:00:00.000Z'));
    assert.ok(fired['repeated-block-id']);
    assert.equal(fired['stale-answer'], false);
    // An update that went through, or another error, isn’t the refusal.
    const ok = call('update_block', { block: { id: 'draft' } }, 'Updated.', false);
    const other = call('show_block', { block: { id: 'x' } }, 'Unknown field “foo”.');
    assert.deepEqual(triggersFired(facts({ streams: [ok, other] }), ['update-over-unread', 'repeated-block-id']), {
      'update-over-unread': false,
      'repeated-block-id': false,
    });
  });

  test('#123: a stale answer is the page’s notice, which the runner records', () => {
    const f = facts({ probes: { stale: [{ key: 'it_1', text: 'This draft changed while you were answering.', at: 5 }], interrupts: [] } });
    assert.deepEqual(triggersFired(f, ['stale-answer'])['stale-answer'], {
      at: 5,
      evidence: 'The page refused the answer to it_1: “This draft changed while you were answering.”',
    });
    // A run saved before the runner recorded it can’t tell.
    assert.equal(triggersFired(facts({ probes: {} }), ['stale-answer'])['stale-answer'], null);
  });

  test('#126: Stop’s question answered Keep running or Stop it too, and Send now with a job running, from the job history', () => {
    const running = [{ id: 'j1', state: 'running', kept: false, turnId: 't' }];
    const asked = { at: 1, jobs: 1 };
    const keep = [
      session(1, 's1', { jobs: running }),
      session(2, 's1', { jobs: running, stopAsk: asked }),
      session(3, 's1', { jobs: running, state: 'stopping' }),
      session(4, 's1', { jobs: [{ ...running[0], kept: true }], state: 'idle', finishedAt: 4 }),
    ];
    const tooEvents = [
      session(1, 's1', { jobs: running }),
      session(2, 's1', { jobs: running, stopAsk: asked }),
      session(3, 's1', { jobs: running, state: 'stopping' }),
      session(4, 's1', { jobs: [], state: 'idle', finishedAt: 4 }),
    ];
    const sendNow = [
      session(1, 's1', { jobs: running }),
      session(2, 's1', { jobs: running, state: 'stopping' }),
      session(3, 's1', { jobs: [{ ...running[0], kept: true }] }),
    ];
    const ids = ['stop-keep-jobs', 'stop-jobs-too', 'send-now-job-running'];
    const hits = (events, interrupts = []) =>
      Object.entries(triggersFired(facts({ events, probes: { stale: [], interrupts } }), ids))
        .filter(([, v]) => v)
        .map(([k]) => k);
    assert.deepEqual(hits(keep), ['stop-keep-jobs']);
    assert.deepEqual(hits(tooEvents, [{ do: 'stop', answered: 'Stop it too', at: 10 }]), ['stop-jobs-too']);
    // A “Stop it too” for another job, long after this one’s turn stopped, isn’t this one’s answer.
    assert.deepEqual(hits(tooEvents, [{ do: 'stop', answered: 'Stop it too', at: 3 + 120_000 }]), []);
    // Without the runner’s record of “Stop it too”, a job that ended with its turn could be one Postbox failed to keep.
    assert.deepEqual(hits(tooEvents, [{ do: 'stop', answered: 'Keep running' }]), []);
    assert.deepEqual(hits(sendNow), ['send-now-job-running']);
    // Dismissing the question and letting the job finish is none of them.
    const dismissed = [session(1, 's1', { jobs: running, stopAsk: asked }), session(2, 's1', { jobs: running, state: 'tool' }), session(3, 's1', { jobs: [] })];
    assert.deepEqual(hits(dismissed, [{ do: 'stop', answered: 'Stop it too' }]), []);
    assert.equal(jobTimeline(keep)[0].afterStop, true);
    // A trigger that fails can’t tell, and says why; it isn’t a coverage gap.
    const errors = [];
    const broken = triggersFired({ ...facts(), state: { items: { t1: 5 } }, threads: ['t1'] }, ['wake-full-text'], {
      onError: (id, e) => errors.push(`${id}: ${e.message}`),
    });
    assert.deepEqual(broken, { 'wake-full-text': null });
    assert.equal(errors.length, 1);
    // A history from before the runner kept stopAsk can’t tell.
    assert.equal(
      triggersFired(facts({ events: [{ seq: 1, type: 'session', data: { id: 's1', state: 'idle' } }] }), ['stop-keep-jobs'])['stop-keep-jobs'],
      null,
    );
  });

  test('the history keeps Stop’s question and the jobs, cut to what the triggers read', () => {
    const e = keepEvent(7, 'session', {
      id: 's1',
      state: 'tool',
      finishedAt: null,
      updatedAt: 3,
      stopAsk: { jobs: 1, text: 'long text', turnId: 't', at: 9 },
      jobs: [{ id: 'j1', state: 'running', kept: true, command: 'x'.repeat(9000), turnId: 't' }],
      personaSnapshot: { big: true },
    });
    assert.deepEqual(e?.data, {
      id: 's1',
      state: 'tool',
      finishedAt: null,
      updatedAt: 3,
      stopAsk: { at: 9, jobs: 1 },
      jobs: [{ id: 'j1', state: 'running', kept: true, turnId: 't' }],
    });
  });
});

describe('phases that end on their triggers', () => {
  const scenario = parseScenario(
    '# T\n\nGo.\n\n## Phase 1: Wake\n\n- triggers: repeated-block-id\n- steps: 2\n\nA.\n\n## Phase 2: Draft\n\n- triggers: update-over-unread\n- steps: 2\n\nB.\n\n## Phase 3: Look\n\nC.\n',
  );
  const refused = call('show_block', { block: { id: 'draft' } }, 'Block draft is already shown. Use update_block to change it, or pick a new id.');

  test('once a phase’s triggers happen, the tester is told, finishes the phase, and the run moves on within GRACE steps', () => {
    const g = phaseGoals(scenario, { cap: phaseCap });
    g.observe(facts(), 0);
    let r = g.check(0, 1);
    assert.equal(r.phase, 0);
    assert.match(r.note, /done when Postbox shows that it refused show_block for an id the agent already showed\. You have 2 steps left/);
    g.took(0);
    g.observe(facts({ streams: [refused] }), 1);
    r = g.check(0, 2);
    // Not cut off: the phase’s own judging (approve the draft, check what the agent got) still needs a step or two.
    assert.equal(r.phase, 0);
    assert.match(r.note, /Phase 1 is done: Postbox showed that it refused show_block[\s\S]*answer next_phase; the run moves on by itself after 2 more steps/);
    // Saying next_phase is never held once the triggers happened.
    assert.equal(g.leave(0), null);
    for (let n = 0; n < GRACE; n++) g.took(0);
    r = g.check(0, 4);
    assert.equal(r.phase, 1);
    assert.match(r.note, /moved on to Phase 2/);
    const c = g.coverage();
    assert.deepEqual(
      c.map((x) => [x.trigger, x.hit, x.step]),
      [
        ['repeated-block-id', true, 1],
        ['update-over-unread', false, null],
      ],
    );
  });

  test('at its cap, a phase whose trigger never happened is a coverage gap, and the report says the fix went untested', () => {
    const g = phaseGoals(scenario, { cap: phaseCap });
    g.observe(facts({ streams: [refused] }), 1);
    assert.equal(g.check(0, 1).phase, 0);
    // The tester says next_phase once it has finished phase 1.
    assert.equal(g.leave(0), null);
    g.took(1);
    g.took(1);
    const r = g.check(1, 3);
    // Phase 3 has no triggers: the tester ends it, as before.
    assert.equal(r.phase, 2);
    assert.equal(r.end, null);
    assert.match(r.note, /Phase 2’s goal didn’t happen in its 2 steps/);
    const [gap] = g.gaps();
    assert.equal(gap.check, 'coverage-gap');
    assert.equal(gap.verdict, 'measurement');
    assert.deepEqual(gap.refs, [123]);
    assert.match(gap.title, /Phase 2’s trigger “update-over-unread” never happened/);
    assert.match(gap.evidence, /this run didn’t test the fix for #123 \(Phase 2: Draft\)/);
    const md = coverageSection(g.coverage()).join('\n');
    assert.match(md, /## Coverage/);
    assert.match(md, /\| Phase 2: Draft \| update-over-unread \| #123 \|[^\n]*\*\*never\*\* \| 2 of 2 \|/);
    assert.match(md, /\*\*Not tested by this run:\*\* #123 \(update-over-unread\)/);
  });

  test('moving on early is held once, then recorded as a gap; the last phase ends the run when it’s done', () => {
    const g = phaseGoals(scenario, { cap: phaseCap });
    g.observe(facts(), 1);
    assert.match(String(g.leave(0)), /^Not yet: this phase is there to make Postbox show/);
    assert.equal(g.leave(0), null);
    assert.equal(g.gaps().length, 1);
    assert.match(g.gaps()[0].evidence, /the tester moved on/);
    // A scenario whose last phase has triggers: done means up to GRACE steps to judge it, then the end.
    const last = parseScenario('# T\n\n## Phase 1\n\n- triggers: repeated-block-id\n\nA.\n');
    const h = phaseGoals(last, { cap: phaseCap });
    h.observe(facts({ streams: [refused] }), 1);
    assert.equal(h.check(0, 1).end, null);
    assert.match(h.check(0, 1).note, /then answer done/);
    for (let n = 0; n < GRACE; n++) h.took(0);
    assert.equal(h.check(0, 3).end, 'now');
    const i = phaseGoals(last, { cap: phaseCap });
    i.observe(facts(), 1);
    for (let n = 0; n < PHASE_STEPS; n++) i.took(0);
    assert.equal(i.check(0, 9).end, 'now');
  });

  test('a run that ends early leaves every phase it didn’t finish as a gap; one that started later skips the earlier ones', () => {
    const g = phaseGoals(scenario, { cap: phaseCap, start: 1 });
    g.observe(facts(), 1);
    g.finish(1);
    assert.deepEqual(
      g.gaps().map((x) => x.key),
      ['phase-2:update-over-unread'],
    );
    const c = g.coverage();
    assert.equal(c[0].skipped, true);
    assert.match(coverageSection(c).join('\n'), /skipped \(the run started later\)/);
  });
});

// ── Keeping runs ───────────────────────────────────────────────────────────────────────────

describe('run folders that outlive worktrees', () => {
  test('runs go to POSTBOX_UAT_RUNS, else uat-runs/ beside the main checkout’s .git, else this repo', () => {
    const git = (common) => () => common;
    assert.equal(runsRoot({ root: '/w/wt', env: { POSTBOX_UAT_RUNS: '/keep/runs' }, git: git('/main/.git') }), '/keep/runs');
    assert.equal(runsRoot({ root: '/main/.claude/worktrees/a', env: {}, git: git('/main/.git') }), '/main/uat-runs');
    assert.equal(runsRoot({ root: '/w/wt', env: {}, git: git(null) }), '/w/wt/uat-runs');
  });

  test('JSON is written atomically, with nothing left beside it', () => {
    const dir = tmp();
    try {
      writeJsonAtomic(join(dir, 'findings.json'), { a: 1 });
      writeJsonAtomic(join(dir, 'findings.json'), { a: 2 });
      assert.deepEqual(JSON.parse(readFileSync(join(dir, 'findings.json'), 'utf8')), { a: 2 });
      assert.deepEqual(readdirSync(dir), ['findings.json']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('run.json says what a refit needs; a run without one is read from its report, findings and streams', () => {
    const rec0 = {
      root: '/r',
      dir: '/runs/2026-10-23T04-30-34-p0',
      scenario: read('p0'),
      name: 'p0',
      opt: { 'tester-model': 'claude-sonnet-5-5', 'agent-effort': 'low' },
      started: 0,
      now: 26 * 60000,
      steps: 15,
      cap: 28,
      tester: { spent: 1.5 },
      facts: {
        streams: [
          {
            events: [
              { type: 'system', subtype: 'init', model: 'claude-haiku-5-5' },
              { type: 'result', total_cost_usd: 2.25 },
            ],
          },
        ],
      },
      coverage: [],
      git: (args) => (args.includes('--abbrev-ref') ? 'uat-scale' : 'abc123'),
    };
    const rec = runRecord(rec0);
    assert.deepEqual(rec, {
      run: '2026-10-23T04-30-34-p0',
      scenario: 'p0',
      title: read('p0').title,
      kind: 'targeted',
      branch: 'uat-scale',
      commit: 'abc123',
      agents: { model: 'claude-haiku-5-5', effort: 'low' },
      testerModel: 'claude-sonnet-5-5',
      steps: 15,
      stepCap: 28,
      startPhase: 1,
      minutes: 26,
      cost: { agents: 2.25, tester: 1.5, kiroCredits: null },
      coverage: [],
    });
    assert.deepEqual(reportFacts('Run on 2026-10-23 04:30, 26 min, 15 steps. Usage: agents $28.59, tester $1.50.'), {
      minutes: 26,
      steps: 15,
      agentsUsd: 28.59,
      kiroCredits: null,
      testerUsd: 1.5,
      agentModel: null,
      agentEffort: null,
    });
    assert.equal(streamModel([{ events: [{ type: 'system', subtype: 'init', model: 'a' }] }, { events: [] }]), 'a');
    // The report's own line, as the runner writes it, gives the first agent's model and effort.
    const usage = 'Run on 2026-10-23 07:11, 14 min, 15 steps. Usage: agents $0.96, tester $11.92.';
    assert.deepEqual(reportFacts(`${usage} Agents: @researcher claude-haiku-5-5, low effort; @critic claude-haiku-5-5, low effort.`), {
      minutes: 14,
      steps: 15,
      agentsUsd: 0.96,
      kiroCredits: null,
      testerUsd: 11.92,
      agentModel: 'claude-haiku-5-5',
      agentEffort: 'low',
    });
    assert.equal(reportFacts(`${usage} Agents: @researcher its default model.`).agentModel, null);
    // A `- models: persona` run records the effort its agents were seeded with, not the runner's --agent-effort.
    const persona = (agentEffort) => runRecord({ ...rec0, facts: { streams: [], agentEffort } }).agents.effort;
    assert.equal(persona('high'), 'high');
    assert.equal(persona('high/default'), 'high/default');
    assert.equal(persona(null), null);
    const root = tmp();
    try {
      const dir = join(root, '2026-10-22T01-02-09-hotpotqa');
      mkdirSync(join(dir, 'streams'), { recursive: true });
      mkdirSync(join(root, '2026-10-22T01-01-16-hotpotqa'));
      writeFileSync(
        join(dir, 'findings.json'),
        JSON.stringify({ testerSpent: 2, timeline: [{}, {}, {}], findings: [{ source: 'tester', step: 1, title: 'X' }] }),
      );
      writeFileSync(
        join(dir, 'streams', '1-researcher.jsonl'),
        '{"type":"system","subtype":"init","model":"claude-opus-5-5"}\n{"type":"result","total_cost_usd":3.5}\n',
      );
      const r = readRun(dir, { scenarios: new URL('uat/e2e/scenarios', import.meta.url).pathname });
      assert.equal(r?.scenario, 'hotpotqa');
      assert.equal(r?.kind, 'exploratory');
      assert.equal(r?.steps, 3);
      assert.deepEqual(r?.agents, { model: 'claude-opus-5-5', effort: null });
      assert.deepEqual(r?.cost, { agents: 3.5, tester: 2, kiroCredits: null });
      // The unfinished run (no findings.json) is skipped, and counted.
      const all = readRuns([root, root]);
      assert.equal(all.runs.length, 1);
      assert.equal(all.unfinished, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── Verdicts ───────────────────────────────────────────────────────────────────────────────

describe('every finding gets a verdict', () => {
  test('one set of verdicts; older runs’ names map onto it', () => {
    assert.deepEqual(Object.keys(VERDICTS), ['confirmed', 'duplicate', 'harness', 'agent', 'by-design', 'not-reproduced', 'measurement']);
    assert.equal(normalVerdict('agent-work'), 'agent');
    assert.equal(normalVerdict('not reproduced'), 'not-reproduced');
    assert.equal(normalVerdict('measurement: Not a defect'), 'measurement');
    assert.equal(normalVerdict('nonsense'), null);
    // The verifier answers in the same set.
    assert.deepEqual(VERIFY_SCHEMA.properties.results.items.properties.verdict.enum, [
      'confirmed',
      'duplicate',
      'harness',
      'agent',
      'by-design',
      'not-reproduced',
    ]);
  });

  test('a person’s or a reviewer’s verdict wins over the verifier’s, and each is kept with who and when', () => {
    const f = { source: 'tester', title: 'Draft vanished' };
    assert.equal(setVerdict(f, { verdict: 'confirmed', by: 'verifier', at: 't1' }), true);
    assert.equal(setVerdict(f, { verdict: 'harness', by: 'reviewer', note: 'The runner’s click.', at: 't2' }), true);
    assert.equal(setVerdict(f, { verdict: 'confirmed', by: 'verifier', at: 't3' }), false);
    assert.equal(f.verdict, 'harness');
    assert.equal(f.verdictBy, 'reviewer');
    assert.equal(f.verdictAt, 't2');
    assert.deepEqual(
      /** @type {any} */ (f).verdicts.map((v) => [v.verdict, v.by]),
      [
        ['confirmed', 'verifier'],
        ['harness', 'reviewer'],
      ],
    );
    assert.equal(setVerdict(f, { verdict: 'duplicate', by: 'person', issue: 69, at: 't4' }), true);
    assert.equal(/** @type {any} */ (f).duplicateOf, 69);
    assert.throws(() => setVerdict(f, { verdict: 'maybe', by: 'person' }), /isn’t a verdict/);
  });

  test('checks that caught an open issue again are duplicates of it; measurements keep theirs', () => {
    const fs = [
      { source: 'check', check: 'settings-leak', key: 'k', issue: 57 },
      { source: 'check', check: 'prose-instead-of-block', key: 'm', issue: null, verdict: 'measurement' },
      { source: 'tester', title: 'T', issue: 63 },
    ];
    presetVerdicts(fs);
    assert.deepEqual(
      fs.map((f) => [verdictOf(f), /** @type {any} */ (f).verdictBy ?? null]),
      [
        ['duplicate', 'check'],
        ['measurement', 'check'],
        [null, null],
      ],
    );
  });

  test('a finding is named by its index or its key', () => {
    const fs = [
      { source: 'check', check: 'duplicate-block-id', key: 't1:s1:draft' },
      { source: 'tester', title: 'The draft vanished after I approved it' },
    ];
    assert.equal(findFinding(fs, '1').index, 1);
    assert.equal(findFinding(fs, 'duplicate-block-id:t1:s1:draft').index, 0);
    assert.equal(findFinding(fs, 'tester:the-draft-vanished').index, 1);
    assert.throws(() => findFinding(fs, '5'), /no finding 5/);
    assert.throws(() => findFinding(fs, 'nope'), /No finding has the key/);
  });

  test('uat-verdict records a verdict in findings.json, atomically, and refuses a duplicate without its issue', () => {
    const dir = tmp();
    const out = [];
    const io = { now: () => '2026-10-22T23:00:00.000Z', print: (s) => out.push(s) };
    try {
      writeFileSync(
        join(dir, 'findings.json'),
        JSON.stringify({ scenario: 'S', findings: [{ source: 'tester', title: 'A', verdict: 'confirmed', verdictBy: 'verifier' }] }),
      );
      assert.equal(verdictCli([dir, '0', 'duplicate'], io), 2);
      assert.match(out.at(-1), /add --issue N/);
      assert.equal(verdictCli([dir, '0', 'duplicate', 'Same', 'as', '#69', '--issue', '69', '--by', 'person'], io), 0);
      const saved = JSON.parse(readFileSync(join(dir, 'findings.json'), 'utf8'));
      assert.equal(saved.scenario, 'S');
      assert.deepEqual(
        {
          verdict: saved.findings[0].verdict,
          by: saved.findings[0].verdictBy,
          at: saved.findings[0].verdictAt,
          dup: saved.findings[0].duplicateOf,
          note: saved.findings[0].note,
        },
        { verdict: 'duplicate', by: 'person', at: '2026-10-22T23:00:00.000Z', dup: 69, note: 'Same as #69' },
      );
      // A recheck holding the findings in memory keeps the person’s verdict set meanwhile.
      const held = [{ source: 'tester', title: 'A', verdict: 'confirmed', verdictBy: 'verifier', verdictAt: '2026-10-22T22:00:00.000Z' }];
      mergePeopleVerdicts(held, saved.findings);
      assert.equal(held[0].verdict, 'duplicate');
      assert.equal(held[0].verdictBy, 'person');
      // The verifier can’t override a person.
      assert.equal(verdictCli([dir, '0', 'confirmed', '--by', 'verifier'], io), 1);
      assert.equal(verdictCli([dir, '0', 'maybe'], io), 2);
      assert.equal(verdictCli([dir, '--list'], io), 0);
      assert.match(out.at(-1), /^0\ttester:a\tduplicate \(person\)\tA$/);
      assert.deepEqual(readdirSync(dir), ['findings.json']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the tester can answer a block while its agent works, to cause #123’s refusals', () => {
  test('an interrupt can answer, and the tester is told how', () => {
    const it = SCHEMA.properties.action.properties.interrupt;
    assert.deepEqual(it.properties.do.enum, ['stop', 'send_now', 'answer']);
    assert.ok(it.properties.item && it.properties.verdict && it.properties.comments && it.properties.choose && it.properties.button);
    assert.match(systemPrompt({ scenario: parseScenario('# T\n'), issues: [] }), /or answer, to answer the block item while the agent works/);
  });
});

// ── The refit ──────────────────────────────────────────────────────────────────────────────

// The 11 runs the analysis of 22 October 2026 counted (curve.py over runs.json), cut to what the stats read.
const RUNS = JSON.parse(readFileSync(new URL('fixtures/uat/runs-2026-10-22.json', import.meta.url), 'utf8')).map((r) => ({
  ...r,
  kind: r.scenario === 'p0' ? 'targeted' : 'exploratory',
  agents: { model: null, effort: null },
  coverage: null,
}));

describe('uat-stats refits the scale from archived runs', () => {
  test('discovery per step counts only the runs that reached each step', () => {
    const runs = [
      { steps: 2, findings: [{ source: 'tester', step: 1, title: 'a' }] },
      {
        steps: 4,
        findings: [
          { source: 'tester', step: 1, title: 'a' },
          { source: 'tester', step: 3, title: 'b' },
          { source: 'tester', step: 3, title: 'b' },
        ],
      },
    ];
    const c = curve(runs, { max: 4 });
    assert.deepEqual(c.at, [0, 2, 2, 1, 1]);
    assert.deepEqual(c.fresh, [0, 2, 0, 1, 0]);
    assert.deepEqual(c.rate, [0, 1, 0, 1, 0]);
    assert.deepEqual(rateOver(c, 1, 4), { rate: 3 / 6, runSteps: 6, found: 3, runsAtStart: 2, runsAtEnd: 1 });
    // Agent findings, runner findings and measurements aren’t product findings.
    const other = [
      {
        steps: 2,
        findings: [
          { source: 'tester', step: 1, category: 'agent', title: 'x' },
          { source: 'run', step: 1, check: 'stuck' },
          { source: 'check', step: 1, key: 'm', verdict: 'measurement' },
        ],
      },
    ];
    assert.deepEqual(curve(other, { max: 2 }).fresh, [0, 0, 0]);
  });

  test('it reproduces the analysis of 22 October: 0.26, 0.20, 0.18 and 0.09 new findings per step, and 89% of the 20-step yield by step 15', () => {
    const max = Math.max(...RUNS.map((r) => r.steps));
    const tester = curve(RUNS, { max, sources: ['tester'], unmatched: true });
    assert.deepEqual(
      [
        [1, 5],
        [6, 10],
        [11, 15],
        [16, 20],
      ].map(([a, b]) => Number(/** @type {number} */ (rateOver(tester, a, b).rate).toFixed(2))),
      [0.26, 0.2, 0.18, 0.09],
    );
    const y = /** @type {any[]} */ (yieldShare(RUNS, { resamples: 2000 }));
    const at15 = y.find((s) => s.k === 15);
    assert.ok(at15.share > 0.85 && at15.share < 0.92, `step 15: ${at15.share}`);
    assert.ok(at15.lo > 0.75 && at15.lo < 0.85, `step 15 low: ${at15.lo}`);
    assert.equal(at15.hi, 1);
    // Seeded: the same runs give the same interval.
    assert.deepEqual(yieldShare(RUNS, { resamples: 300 }), yieldShare(RUNS, { resamples: 300 }));
    const cost = /** @type {any} */ (costPerStep(RUNS));
    assert.equal(cost.min.usd.toFixed(2), '0.06');
    assert.equal(cost.max.usd.toFixed(2), '5.79');
  });

  test('precision is the share of findings by verdict, and says when too few were reviewed', () => {
    const p = precision([{ findings: [{ verdict: 'confirmed' }, { verdict: 'agent-work' }, { verdict: 'measurement' }, { source: 'check', issue: 57 }, {}] }]);
    assert.deepEqual(p.counts, { confirmed: 1, agent: 1, measurement: 1, duplicate: 1, 'not reviewed': 1 });
    assert.equal(p.reviewed, 3);
    assert.equal(p.share, 2 / 3);
    const lines = summarize('Few', [{ run: 'r', steps: 3, cost: {}, findings: [{ verdict: 'confirmed', step: 2 }] }]).join('\n');
    assert.match(lines, /Too thin to conclude anything: 1 run/);
    assert.match(lines, /too few runs reached step 20 \(0\)/);
    assert.match(lines, /Precision: too few reviewed \(1 of 1/);
    assert.match(lines, /no run recorded its cost/);
  });

  test('coverage per trigger, for targeted runs; and runs are split by kind and by the agents’ model', () => {
    const cov = (hit, step) => [{ phase: 1, trigger: 'stale-answer', issue: 123, hit, step }];
    assert.deepEqual(
      triggerCoverage([
        { run: 'a', coverage: cov(true, 4) },
        { run: 'b', coverage: cov(false, null) },
        { run: 'c', coverage: cov(null, null) },
      ]),
      [{ trigger: 'stale-answer', issue: 123, runs: 3, hit: 1, unknown: 1, steps: [4] }],
    );
    const runs = [
      ...RUNS,
      {
        run: 'h',
        scenario: 'scifact',
        kind: 'exploratory',
        steps: 15,
        agents: { model: 'claude-haiku-5-5', effort: 'low' },
        cost: {},
        findings: [],
        coverage: null,
      },
    ];
    const text = report(runs, { resamples: 200 }).join('\n');
    assert.match(text, /^UAT stats: 12 finished runs\./);
    assert.match(text, /\nAll runs: 12 runs\n/);
    assert.match(text, /\nExploratory runs: 11 runs\n/);
    assert.match(text, /\nTargeted runs: 1 run\n/);
    assert.match(text, /\nExploratory runs, agents on claude-haiku-5-5: 1 run\n/);
    assert.match(text, /Coverage per trigger: no run here recorded it/);
    assert.match(text, /h \(exploratory, claude-haiku-5-5 at low, 15 steps\)/);
  });
});
