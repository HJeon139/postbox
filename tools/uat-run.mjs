// UAT, end to end. Starts a fresh Postbox with real agents, opens it in headless Chromium, and lets a tester
// model play the person through a scenario (tests/uat/e2e/scenarios/*.md): it writes messages, answers
// blocks, uses apps and topic threads, and judges every step. Deterministic checks (tools/uat/checks.mjs)
// run alongside it. The report lists every finding, and which open GitHub issues the run caught again.
//
//   node tools/uat-run.mjs --scenario scifact
//   node tools/uat-run.mjs --scenario hotpotqa --steps 30 --budget 6 --tester-model claude-opus-5-5
//
// Real agents and the tester both run on the claude CLI you’re signed in to, so a run costs real usage. --budget caps
// the tester; --max-cost caps the whole run (agents, tester, verifier and telemetry), stopping it, report and all, before
// a step or an agent turn could pass the cap (tools/uat/budget.mjs). Without --max-cost the agents are uncapped. A scenario
// can put agents on another backend (`- backends: critic=kiro-cli:gpt-5.6-terra`); those use that CLI’s sign-in, and
// the scenario is a compatibility run, which needs --compat, the Antigravity CLI’s included. A backend kept to version
// releases (none today) needs --release (releaseGate), which also counts as --compat:
//
//   node tools/uat-run.mjs --scenario mixedroom --compat
//
// Host mode (#120) puts agents on other machines over ssh, Claude Code only: --host for each (host1, host2…),
// --host-setting hostN.key=value, and --place over a scenario’s `- place:` (tests/uat/e2e/README.md, “Host mode”):
//
//   node tools/uat-run.mjs --scenario remotehosts --host host-a.example.com --host host-b.example.com
//
// Everything a run makes goes in uat-runs/<time>-<scenario>/ in the main checkout, or POSTBOX_UAT_RUNS (tools/uat/runs.mjs),
// ignored by git: report.md, findings.json, run.json, screenshots, each agent turn’s raw stream, and Postbox’s data.
// A run is 15 steps unless its scenario or --steps says otherwise; a targeted scenario’s phases end on their triggers
// (tools/uat/triggers.mjs). Every finding gets a verdict: the verifier’s after the run, or yours (tools/uat-verdict.mjs).

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { launch, sleep } from './browser.mjs';
import { openBigRoom } from './uat/big-room.mjs';
import { parseMaxCost, runBudget } from './uat/budget.mjs';
import { MID_TURN, runChecks, waitingOnYou } from './uat/checks.mjs';
import { streamResults } from './uat/cost.mjs';
import { driver, JOBS_ANSWERS } from './uat/driver.mjs';
import { goToNeedsStep } from './uat/driver-needs.mjs';
import { faultSetup } from './uat/fault-run.mjs';
import { followEvents } from './uat/history.mjs';
import { endHosts } from './uat/hosts-end.mjs';
import { HOST_OPTIONS, hostMode } from './uat/hosts-options.mjs';
import { createHostRun, startHosts } from './uat/hosts-run.mjs';
import { afterStep, beforeStop, fault, sample } from './uat/hosts-watch.mjs';
import { observe as observeScreen } from './uat/observe.mjs';
import { portFree, startPostbox } from './uat/postbox.mjs';
import { newProbes } from './uat/probes.mjs';
import { recheck } from './uat/recheck.mjs';
import { presetFindings } from './uat/regressions.mjs';
import { writeReport } from './uat/report.mjs';
import { reviewFindings } from './uat/review.mjs';
import { readStreams, readTranscripts, readUi, runPaths, userSetup } from './uat/run-files.mjs';
import { gitInfo, runRecord, runsRoot, writeJsonAtomic } from './uat/runs.mjs';
import { compatBackends, parseScenario, phaseCap, releaseGate, stepCap } from './uat/scenario.mjs';
import { seedAgents } from './uat/seed.mjs';
import { onStopSignal, runStop } from './uat/stop.mjs';
import * as tm from './uat/telemetry-run.mjs';
import { createTester, systemPrompt, unaddressed } from './uat/tester.mjs';
import { phaseGoals, unknownTriggers } from './uat/triggers.mjs';
import { sendThenStop, settle as settleTurns, stopThroughPage, WAIT_MAX_S, watchBudget } from './uat/turns.mjs';
import { makeWorkspace } from './uat/workspace.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const { values: opt } = parseArgs({
  options: {
    scenario: { type: 'string', default: 'scifact' },
    port: { type: 'string', default: '4310' },
    // The most steps: the scenario’s own `- steps: N`, else a targeted scenario’s phase caps added up, else 15.
    steps: { type: 'string' },
    // Start at this phase (1 is the first), to rerun a later one without the earlier ones; the tester sets up what it needs.
    phase: { type: 'string', default: '1' },
    'turn-timeout': { type: 'string', default: '900' },
    budget: { type: 'string', default: '8' },
    // The most the whole run may spend, in dollars (tools/uat/budget.mjs). Unset, only --budget caps the tester.
    'max-cost': { type: 'string' },
    'tester-model': { type: 'string', default: 'claude-sonnet-5-5' },
    // The agents’ model and effort. A pass checks that Postbox works, and a fast model shows that as well as the
    // default one does. Scenarios that measure what agents choose say `- models: persona`, and `persona` here keeps
    // personas.json’s settings for every scenario.
    'agent-model': { type: 'string', default: 'claude-haiku-5-5' },
    'agent-effort': { type: 'string', default: 'low' },
    'force-agent-model': { type: 'boolean', default: false },
    recheck: { type: 'string' },
    // After a run, verify the findings that have no verdict (--verify no skips it), and file the confirmed ones that no
    // open issue covers (--file no verifies without filing).
    // (A recheck verifies only when it files, unless --verify yes: --recheck --file no stays free.)
    verify: { type: 'string' },
    file: { type: 'string', default: 'yes' },
    // The run for a version release: only it may use the release-only backends (tools/uat/scenario.mjs, RELEASE_ONLY).
    release: { type: 'boolean', default: false },
    // Run a compatibility scenario: one with agents on a backend other than Claude’s, such as the Kiro CLI.
    compat: { type: 'boolean', default: false },
    // Host mode’s options (#120, tools/uat/hosts-options.mjs).
    ...HOST_OPTIONS,
    // Every run records itself and saves one telemetry report (designs/telemetry-persona.md, U4); no opts out.
    telemetry: { type: 'string', default: 'yes' },
  },
});

// What verifying and filing need from here (tools/uat/review.mjs).
const REVIEW = { root: ROOT, testerModel: opt['tester-model'] };

// ── Run ────────────────────────────────────────────────────────────────────────────────────

async function main() {
  const scenarioFile = existsSync(opt.scenario) ? opt.scenario : join(ROOT, 'tests', 'uat', 'e2e', 'scenarios', `${opt.scenario}.md`);
  const name = opt.scenario.replace(/^.*\//, '').replace(/\.md$/, '');
  // Host mode (#120): agents on other machines over ssh (--host), Claude Code only (tools/uat/hosts-options.mjs).
  const { hosts, placement, scenario } = hostMode(opt, name, parseScenario(readFileSync(scenarioFile, 'utf8')));
  const other = compatBackends(scenario);
  if (other.length && !opt.compat && !opt.release)
    throw new Error(
      `This scenario puts agents on ${other.join(' and ')}, so it’s a compatibility run, which runs only when asked: it uses that harness’s credits, and a regular pass is Claude only. Pass --compat to run it.`,
    );
  // A release-only backend (none today: tools/uat/scenario.mjs) runs only in a release run; otherwise Postbox starts
  // without it, so the tester can’t put an agent on it from a sheet either.
  const gate = releaseGate(scenario, { release: opt.release });
  if (gate.error) throw new Error(gate.error);
  const unknown = unknownTriggers(scenario);
  if (unknown.length) throw new Error(`This scenario names triggers that don’t exist: ${unknown.join(', ')}. See tools/uat/triggers.mjs.`);
  const steps = stepCap(scenario, opt.steps);
  const budget = runBudget({ cap: parseMaxCost(opt['max-cost']), testerShare: Number(opt.budget) });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dir = join(runsRoot({ root: ROOT }), `${stamp}-${name}`);
  const paths = await runPaths(dir);
  const canaries = makeWorkspace(scenario, paths, dir);
  // A phase’s `- fault:` (#508): Postbox starts with the fault launcher in front of the faulted agent’s CLI.
  const faults = faultSetup({ scenario, root: ROOT, dir, env: process.env });
  const logLines = [];
  const log = (line) => {
    const l = `[${new Date().toLocaleTimeString('en-US', { hour12: false })}] ${line}`;
    logLines.push(l);
    console.log(l);
  };
  const started = Date.now();
  log(`UAT “${scenario.title}” → ${dir}, at most ${steps} steps`);

  // Open issues, so the tester and the report can name the ones a run catches again.
  const gh = spawnSync('gh', ['issue', 'list', '--state', 'open', '--limit', '200', '--json', 'number,title'], { cwd: ROOT, encoding: 'utf8' });
  const issues = gh.status === 0 ? JSON.parse(gh.stdout) : [];
  log(`${issues.length} open issues to match against.`);

  const port = Number(opt.port);
  const origin = `http://127.0.0.1:${port}`;
  // The runner must talk to its own fresh Postbox, never to one that’s already running there.
  if (!(await portFree(port))) throw new Error(`Port ${port} is in use. Pick another with --port.`);
  const { agentModels, agentEffort } = await seedAgents({ scenario, opt, root: ROOT, data: paths.data, log });
  // Ctrl-C cleans the hosts up through the page before anything stops (tools/uat/stop.mjs), with what’s there by then.
  const run = { log };
  const stop = runStop(run);
  const signals = onStopSignal(stop, { log });
  const postbox = await startPostbox({
    root: ROOT,
    port,
    data: paths.data,
    env: {
      ...gate.env,
      POSTBOX_CLAUDE_RECORD: paths.streams,
      POSTBOX_KIRO_RECORD: paths.kiroStreams,
      POSTBOX_AGY_RECORD: paths.agyStreams,
      POSTBOX_CODEX_RECORD: paths.codexStreams,
      ...tm.telemetryEnv(scenario, dir, opt),
      ...faults?.env,
    },
    log,
  });
  const { api } = postbox;
  // What happened, in order, from the first event: the checks for #123 need history the state doesn’t keep.
  const history = followEvents(origin);
  const page = await launch({ detached: true });
  // Host mode’s record of its hosts (tools/uat/hosts-run.mjs), which its checks and triggers read as facts.hosts.
  const hr = hosts.length ? createHostRun({ hosts, placement, launcher: scenario.launcher, root: ROOT, stamp, data: paths.data, log }) : null;
  Object.assign(run, { hr, history, page, postbox });
  if (hr) hr.hostStates = history.hostStates;
  const findings = new Map(); // key → finding
  const timeline = [];
  const facts = {
    agentModels,
    agentEffort,
    state: null,
    threads: [],
    startPersonas: [],
    streams: [],
    kiroStreams: [],
    agyStreams: [],
    codexStreams: [],
    events: [],
    transcripts: [],
    console: page.logs,
    apps: {},
    probes: newProbes(),
    samples: [],
    ui: {},
    ...userSetup(paths.workspace),
    ...(hr ? { hosts: hr.record } : {}),
  };
  let unwatch = () => {};
  try {
    await page.size(1440, 1000, { theme: 'light' });
    await page.goto(`${origin}/`);
    const state0 = (await api('/api/state')).state;
    facts.startPersonas = Object.values(state0.personas).filter((p) => !p.retired);
    const d = driver(page, { beforeStop: () => beforeStop(hr) });
    await d.newProject(scenario.project, paths.workspace);
    if (hr) await startHosts(hr, { postbox, api, kit: d.kit, dir, project: scenario.project });
    const hash = await d.newConversation(scenario.project, scenario.conversation, scenario.agents);
    const mainThread = /#\/t\/([^/]+)/.exec(hash)?.[1];
    if (!mainThread) throw new Error(`Starting the conversation didn’t open it (at ${hash}).`);
    log(`Conversation ${mainThread} started with @${scenario.agents.join(', @')}.`);
    // `- seed: big-room` (#508): the conversation fills with about 1,000 generated items before the tester arrives.
    if (scenario.seed === 'big-room')
      scenario.summary += `\n\n${await openBigRoom({ postbox, data: paths.data, threadId: mainThread, agents: scenario.agents, page, log })}`;
    const { td, tel } = await tm.startTelemetry(page, { scenario, opt, log });

    const tester = createTester({ cwd: dir, model: opt['tester-model'], budgetUsd: Number(opt.budget), log });
    budget.track({ streams: streamResults(paths.streams), tester, log });
    const system = systemPrompt({ scenario, issues });
    const labels = new Map(); // item key → I1…
    const keys = new Map(); // I1… → item key
    const seen = new Map(); // item key → text last shown to the tester
    let phase = Math.min(Math.max(Number(opt.phase) - 1 || 0, 0), scenario.phases.length - 1);
    if (phase) log(`Starting at phase ${phase + 1}: ${scenario.phases[phase].title}.`);
    // A targeted phase ends when its triggers have happened, or at its step cap (tools/uat/triggers.mjs).
    const startPhase = phase;
    const goals = phaseGoals(scenario, { cap: phaseCap, start: phase, log });
    const blockById = (st, id) =>
      Object.values(st?.items ?? {})
        .flatMap((list) => list ?? [])
        .find((x) => x?.id === id);
    /** @type {Set<string>} */
    const staleSeen = new Set();
    // Postbox’s notice on a block whose answer it refused because it changed meanwhile (#123): the page’s own record.
    const noteStale = async () => {
      const notes = await d.staleNotes().catch((e) => {
        log(`Couldn’t read the page’s stale-answer notices, so the stale-answer trigger may be missed: ${e.message}`);
        return [];
      });
      for (const n of notes ?? []) {
        if (!n?.key || staleSeen.has(`${n.key}\n${n.text}`)) continue;
        staleSeen.add(`${n.key}\n${n.text}`);
        facts.probes.stale.push({ key: n.key, text: n.text, at: Date.now(), step: timeline.length });
        log(`the page refused a stale answer to ${n.key}: ${n.text}`);
      }
    };
    // An answer while the agent works (an interrupt that answers), to cause #123’s refusals: the page answers the
    // revision it showed, whatever the agent has done since.
    const answerMidTurn = async (it) => {
      const key = keys.get(it.item);
      if (!key) throw new Error(`There’s no item ${it.item}.`);
      const now = blockById((await api('/api/state')).state, key);
      if (now?.kind === 'block') facts.probes.answers.push({ key, revision: now.revision ?? 1, at: Date.now() });
      if (it.verdict) await d.review(key, { verdict: it.verdict, comments: it.comments ?? [] });
      else await d.act(key, { fills: it.fills ?? [], choose: it.choose ?? [], button: it.button ?? null });
      await sleep(1000);
      await noteStale();
      return `Answered ${it.item}${now?.revision ? ` (at revision ${now.revision} when you answered)` : ''} while the agent worked.`;
    };
    // What the tester breaks on purpose in a host run (tools/uat/hosts-watch.mjs).
    const hostFault = (spec) => (hr ? fault(hr, spec, page) : Promise.reject(new Error('A fault needs a run with --host.')));
    let lastAction = null;
    let actionError = null;
    let actionResult = null; // what an action measured, when it worked
    let pushedBack = ''; // the waiting list the tester was last told to answer before moving on

    const threadsUnderTest = (state) => [
      mainThread,
      ...Object.values(state.threads)
        .filter((t) => t.parentId === mainThread)
        .map((t) => t.id),
    ];
    const refreshFacts = async () => {
      facts.state = (await api('/api/state')).state;
      facts.threads = threadsUnderTest(facts.state);
      facts.streams = readStreams(paths.streams);
      facts.kiroStreams = readStreams(paths.kiroStreams);
      facts.agyStreams = readStreams(paths.agyStreams);
      facts.codexStreams = readStreams(paths.codexStreams);
      facts.events = history.events();
      facts.transcripts = readTranscripts(facts, paths.workspace);
      const telOpts = { dir, data: paths.data, workspace: paths.workspace, main: mainThread, canaries, flags: tel.flags, shown: tel.shown };
      if (tm.telemetryOn(opt)) tm.telemetryFacts(facts, { ...telOpts, startedBeforeTurns: tm.runnerRecords(scenario, opt) });
      Object.assign(facts.ui, await readUi(page));
    };
    const newFindings = (only = null) => {
      const fresh = [];
      for (const f of runChecks(facts, { only })) {
        const k = `${f.check}:${f.key}`;
        if (findings.has(k)) continue;
        const x = { ...f, source: 'check', step: timeline.length, phase: scenario.phases[phase]?.title };
        findings.set(k, x);
        fresh.push(x);
        log(`check ${f.check}${f.issue ? ` (#${f.issue})` : ''}: ${f.title}`);
      }
      return fresh;
    };

    // Some defects show only while a turn runs: a background command’s step reads done while the command runs, and the
    // turn ends only when the command does (#126). Those checks also run every 15 s while agents work, and what they
    // find goes to the tester with the next step.
    const midTurn = [];
    let lastMidTurn = 0;
    const midTurnChecks = async (st = null) => {
      if (hr) await sample(hr, st ?? (await api('/api/state')).state);
      if (Date.now() - lastMidTurn < 15_000) return;
      lastMidTurn = Date.now();
      facts.state = st ?? (await api('/api/state')).state;
      facts.threads = threadsUnderTest(facts.state);
      facts.streams = readStreams(paths.streams);
      facts.events = history.events();
      midTurn.push(...newFindings(MID_TURN));
    };

    // What needs the person that a wait between steps has seen: it hands back to the tester once for each (#289).
    const told = new Set();
    const settle = (handBack = false) => settleTurns({ api, d, threadsUnderTest, facts, midTurnChecks, opt, told, handBack, log });

    const observe = () => observeScreen({ d, labels, keys, seen, paths, timeline, dir, facts });

    // With --max-cost, the budget watches the agents’ turns through the steps and the wait after them.
    unwatch = watchBudget({ budget, api, threadsUnderTest, stop: stopThroughPage(page), log });
    for (let step = 1; step <= steps; step++) {
      if (signals.stopping) throw new Error('The run was stopped by a signal.');
      const timedOut = await settle(true);
      if (budget.stopped) break;
      await refreshFacts();
      if (hr) await afterStep(hr, facts);
      if (timedOut)
        findings.set(`stuck:${step}`, { source: 'run', check: 'stuck', issue: null, title: 'An agent turn ran past the time limit', evidence: timedOut, step });
      const obs = await observe();
      await noteStale();
      // What the last step’s action caused is that step’s.
      goals.observe(facts, timeline.length);
      const goal = goals.check(phase, step);
      if (goal.end === 'now') break;
      if (goal.phase !== phase) log(`phase ${phase + 1} → ${goal.phase + 1}: ${goal.note}`);
      phase = goal.phase;
      faults?.arm(phase, log);
      const fresh = [...midTurn.splice(0), ...newFindings()];
      // Stop’s question about background jobs (#126) can be a dialog, which isn’t an item: say it’s there.
      const jobsAsk = await d.jobsAsk();
      const ph = scenario.phases[phase];
      // What “needs you” counts, every step, whether or not it changed: an old review draft stays on the list.
      const waiting = waitingOnYou(facts.state, facts.threads).map((w) => {
        const label = w.itemId ? labels.get(w.itemId) : null;
        const where = facts.state.threads[w.threadId];
        return `${label ? `[${label}] ` : ''}${w.what}${where && w.threadId !== mainThread ? ` (in the thread “${where.title}”${label ? '' : ', not on screen: open it'})` : ''}`;
      });
      const prompt = [
        `Step ${step} of at most ${steps}. Phase ${phase + 1} of ${scenario.phases.length}: ${ph.title}`,
        ph.text,
        goal.note,
        lastAction
          ? `Your last action: ${JSON.stringify(lastAction)}${actionError ? `. It failed: ${actionError}` : ''}${actionResult ? `. Result: ${actionResult}` : ''}`
          : phase
            ? `Nothing has happened yet. This run starts at phase ${phase + 1}, skipping the ones before it, so first set up briefly what this phase needs (the earlier phases are only context): ${scenario.phases
                .slice(0, phase)
                .map((p) => p.title)
                .join('; ')}.`
            : 'Nothing has happened yet: start the phase.',
        timedOut ? `The run itself pressed Stop: ${timedOut} A “Stopped by you” line is from that, not a bug.` : '',
        obs.items.length ? `What changed on screen:\n\n${obs.items.join('\n\n')}` : 'Nothing changed on screen.',
        `Agents: ${obs.states.join('; ') || 'none yet'}`,
        waiting.length ? `Waiting on you:\n${waiting.map((w) => `- ${w}`).join('\n')}` : 'Nothing is waiting on you.',
        jobsAsk ? `Postbox is asking about background jobs: “${jobsAsk}” Answer it with jobs.` : '',
        fresh.length ? `The automatic checks found:\n${fresh.map((f) => `- ${f.title}${f.issue ? ` (#${f.issue})` : ''}: ${f.evidence}`).join('\n')}` : '',
      ]
        .filter(Boolean)
        .join('\n\n');
      // With --max-cost, the step goes ahead only if it, and an agent turn it may start, fit what’s left.
      const busy = obs.states.filter((s) => /: (?:think|tool|gen)\b/.test(s)).length;
      if (budget.beforeStep({ step, working: busy })) break;
      const answer = await tester.step(prompt, system);
      goals.took(phase);
      timeline.push({ step, phase: ph.title, assessment: answer.assessment, action: answer.action });
      log(`step ${step} · ${answer.assessment}`);
      for (const f of answer.findings) {
        const k = `tester:${f.title.toLowerCase().replace(/\W+/g, '-').slice(0, 60)}`;
        if (!findings.has(k)) {
          findings.set(k, { ...f, source: 'tester', step, phase: ph.title });
          if (tm.runnerRecords(scenario, opt)) tm.noteFlag(tel.flags, facts.state, facts.threads, f);
          log(`tester ${f.severity} ${f.category}${f.issue ? ` (#${f.issue})` : ''}: ${f.title}`);
        }
      }
      const a = answer.action;
      lastAction = a;
      actionError = null;
      actionResult = null;
      log(`action: ${JSON.stringify(a)}`);
      // The budget’s watch can stop the run while the tester thinks: its action would start a turn past the cap.
      if (budget.stopped) break;
      // Moving on, or waiting while no agent works, past something that waits on the person: say so once, and ask
      // again. A second try with the same list goes ahead, so a run can’t loop on a block it can’t answer.
      const idle = !busy;
      if (waiting.length && (a.type === 'next_phase' || a.type === 'done' || (a.type === 'wait' && idle)) && pushedBack !== waiting.join('\n')) {
        pushedBack = waiting.join('\n');
        // The same again goes ahead, so a scenario that says to leave a card open (for a minute, say) still can.
        actionError = `Not yet: ${waiting.length === 1 ? 'this is' : 'these are'} still waiting on you: ${waiting.join('; ')}. Answer ${waiting.length === 1 ? 'it' : 'them'} first, or, to leave ${waiting.length === 1 ? 'it' : 'them'} waiting on purpose, as the scenario says to, ask for the same again: the second time it goes ahead.`;
        log(`action held: ${waiting.length} waiting on the person`);
        continue;
      }
      // An interrupt acts on the turn running when it starts, and the wait can hand back while one runs (#289).
      if (a.interrupt && !idle) {
        actionError =
          'Not yet: an agent is still working, so an interrupt would act on its turn, not the one this starts. Answer what needs you, or wait, first.';
        log('action held: an interrupt while an agent works');
        continue;
      }
      // Moving on from a phase whose triggers haven’t happened: held once, then a coverage gap.
      const held = a.type === 'next_phase' || a.type === 'done' ? goals.leave(phase) : null;
      if (held) {
        actionError = held;
        log('action held: the phase’s triggers haven’t happened');
        continue;
      }
      if (a.type === 'done') break;
      if (a.type === 'next_phase') {
        phase++;
        if (phase >= scenario.phases.length) break;
        continue;
      }
      try {
        const key = a.item ? keys.get(a.item) : null;
        if (a.item && !key) throw new Error(`There’s no item ${a.item}.`);
        if (a.type === 'telemetry') actionResult = await tm.telemetryAction(td, a, key, tel);
        else if (a.type === 'go_to_needs') actionResult = await goToNeedsStep({ d, page, api, keys, facts, step }, a);
        else if (a.type === 'send') {
          await d.send(a.text ?? '');
          // A message that addresses an agent by name without its @ goes to the last speaker, not to that agent: say
          // so, so the tester knows where it went. The first mixed-room run wrote “critic: …” and “researcher: …”.
          const st = facts.state;
          // Who Postbox sends it to: the last speaker, or before anyone has spoken, the conversation’s first agent.
          const t = st?.threads?.[mainThread];
          const last = st?.sessions?.[t?.lastSpeaker ?? t?.members?.[0]]?.handle ?? null;
          const named = unaddressed(
            a.text ?? '',
            Object.values(st?.personas ?? {}).map((p) => p.handle),
            { lastSpeaker: last },
          );
          if (named.length)
            actionResult = `It addresses “${named[0]}” without the @, so it mentions no agent and went to ${last ? `@${last}, who spoke last` : 'whichever agent spoke last'}. Write @${named[0]} to address it.`;
        } else if (a.type === 'send_then_stop') actionResult = await sendThenStop(d, a, { step, probes: facts.probes, log, onWait: () => midTurnChecks() });
        else if (a.type === 'thread') await d.replyInThread(key, a.text ?? '');
        else if (a.type === 'thread_reply') await d.replyInOpenThread(a.text ?? '');
        else if (a.type === 'act' || a.type === 'review') {
          // An answer is for the revision the tester read. If the block changed while it decided, a person would see
          // it change: say so instead of answering text it didn’t read. Otherwise note the revision it answers, so a
          // check can tell whether Postbox applied the answer to that one (#123).
          const itemIn = (st) =>
            Object.values(st?.items ?? {})
              .flatMap((list) => list ?? [])
              .find((x) => x?.id === key);
          const shown = itemIn(facts.state);
          const now = shown?.kind === 'block' ? itemIn((await api('/api/state')).state) : null;
          if (now && (now.revision ?? 1) !== (shown.revision ?? 1))
            throw new Error(
              `That block changed while you were deciding: you read revision ${shown.revision ?? 1}, and it’s now at revision ${now.revision ?? 1}. Read it again before you answer.`,
            );
          if (now) facts.probes.answers.push({ key, revision: now.revision ?? 1, at: Date.now() });
          if (a.type === 'act') await d.act(key, a);
          else await d.review(key, { verdict: a.verdict, comments: a.comments ?? [] });
          await noteStale();
        } else if (a.type === 'jobs') {
          await d.answerJobs(a.answer);
          facts.probes.interrupts.push({ step, at: Date.now(), do: 'jobs', answered: JOBS_ANSWERS[a.answer]?.[0] ?? null });
        } else if (a.type === 'settings') {
          const r = await d.personaSettings(a.target ?? '', {
            permissions: a.permissions === true,
            shots: paths.shots,
            stem: `${String(step).padStart(2, '0')}-settings`,
          });
          actionResult = [
            `Settings › Personas › @${String(a.target ?? '').replace(/^@/, '')} says:\n${r.editor}`,
            r.panel ? `Its permissions panel says:\n${r.panel}` : '',
            `Screenshots: ${r.files.map((f) => relative(dir, f)).join(', ')}`,
          ]
            .filter(Boolean)
            .join('\n\n');
        } else if (a.type === 'agent_panel') {
          const handle = String(a.target ?? '').replace(/^@/, '');
          const set = { model: a.model, effort: a.effort, mode: a.mode, shell: a.shell };
          const r = await d.agentPanel(handle, set);
          facts.probes.panels.push({ handle, set, left: r.left, at: Date.now() });
          actionResult = `@${handle}’s quick panel says:\n${r.said}\n\nIt was left at: ${JSON.stringify(r.left)}`;
        } else if (a.type === 'pane') {
          const r = await d.openPane(a.open === 'thread' ? 'thread' : 'work', key);
          facts.probes.panes.push({ open: a.open, ...r });
          actionResult = `The right pane: Work ${r.work ? `${r.work.w}×${r.work.h}` : 'not open'}, thread ${r.thread ? `${r.thread.w}×${r.thread.h}` : 'not open'}, in a ${r.viewport.w}×${r.viewport.h} window.`;
        } else if (a.type === 'fullscreen') {
          const shown = await d.fullscreen(a.pane === 'thread' ? 'thread' : 'work');
          actionResult = `Full screen showed:\n${shown || '(nothing)'}\n\nIt’s closed again.`;
        } else if (a.type === 'fullscreen_draft') {
          const r = await d.fullscreenDraft(a.text ?? 'A draft I haven’t sent');
          facts.probes.drafts.push(r);
          actionResult = `Full screen: ${r.full ? 'opened' : 'didn’t open'}. After leaving it, the draft ${r.kept ? 'was still there' : `was ${JSON.stringify(r.draft)}`}, and the thread ended ${r.after.gap} px from its end (it was ${r.before.gap} px).`;
        } else if (a.type === 'restore') {
          actionResult = `Restore said: ${(await d.restoreFile(a.target ?? '')) || '(nothing)'}`;
        } else if (a.type === 'app_click') {
          // The transcript doesn’t change when an app does, so say what the click did inside the app.
          const before = (await d.appInside(key))?.text;
          await d.appClick(key, a.target ?? '');
          const after = (await d.appInside(key))?.text;
          actionResult =
            before === after ? 'The app’s text didn’t change.' : `The app changed. It now begins: “${(after ?? '').replace(/\s+/g, ' ').slice(0, 300)}”`;
        } else if (a.type === 'full_screen') {
          const p = await d.probeFullScreen(key);
          if (p) facts.probes.fullScreen.push({ key, ...p });
          if (p)
            actionResult = `The app frame went from ${p.before.w}×${p.before.h} to ${p.after.w}×${p.after.h}, in a ${p.viewport?.w ?? '?'}×${p.viewport?.h ?? '?'} window.`;
          else actionError = 'That item has no app.';
        } else if (a.type === 'attach_screenshot') {
          const file = await d.shotItem(key, join(paths.shots, `attach-${step}.png`));
          await d.attach(file);
          await d.send(a.text ?? 'What’s this?');
          await sleep(1500);
          const mine = (await d.items()).filter((x) => x.where === 'conversation' && x.attachments > 0).at(-1);
          if (mine) facts.probes.attachments.push({ key: mine.key, images: mine.images, attachments: mine.attachments });
        } else if (a.type === 'fault') actionResult = await hostFault(a);
        else if (a.type === 'wait') await sleep(Math.min(WAIT_MAX_S, a.seconds ?? 30) * 1000);
        else if (a.type === 'stop') await d.stopAll();
        // Stop or Send now while the turn this action started is running (#126).
        if (a.interrupt && ['send', 'thread', 'act', 'review'].includes(a.type)) {
          // Where the turn runs: a reply in a thread, or an answer to a block in the panel, works there.
          const panel = a.type === 'thread' || (key ? await d.inPanel(key) : false);
          // A fault mid-turn is the driver’s answer while the agent works, with the fault for its answer.
          const now = a.interrupt.do === 'fault' ? () => hostFault(a.interrupt) : () => answerMidTurn(a.interrupt);
          const said = await d.interrupt(
            { ...a.interrupt, do: a.interrupt.do === 'fault' ? 'answer' : a.interrupt.do },
            { panel, onWait: () => midTurnChecks(), answer: now },
          );
          facts.probes.interrupts.push({ step, at: Date.now(), do: a.interrupt.do, answered: /You answered “([^”]+)”/.exec(said)?.[1] ?? null });
          actionResult = actionResult ? `${actionResult} ${said}` : said;
        }
      } catch (e) {
        actionError = e.message;
        log(`action failed: ${e.message}`);
        await d.shotScreen(join(paths.shots, `failed-action-${step}.png`)).catch(() => {});
      }
    }
    await settle();
    unwatch();
    // After the last step, no agent takes another turn: the runner’s 🚩s and its report (U4).
    if (tm.runnerRecords(scenario, opt)) await tm.finishTelemetry({ td, flags: tel.flags, dir, data: paths.data, main: mainThread, shown: tel.shown, log });
    await refreshFacts();
    if (hr) await endHosts(hr, dir);
    newFindings();
    // What the last action caused counts, and every phase with triggers that didn’t all happen is a coverage gap.
    await noteStale();
    goals.observe(facts, timeline.length);
    if (goals.check(phase, timeline.length).end !== 'now') goals.finish(phase);
    for (const g of goals.gaps()) findings.set(`coverage-gap:${g.key}`, { ...g, step: timeline.length });
    const coverage = goals.coverage();
    // The history the checks read, for --recheck: Postbox’s own log can lose its first segments to a snapshot.
    await writeFile(join(dir, 'events.jsonl'), facts.events.map((e) => JSON.stringify(e)).join('\n') + (facts.events.length ? '\n' : ''));
    const all = [...findings.values()];
    presetFindings(all, { root: ROOT, commit: gitInfo(ROOT).commit });
    if (facts.telemetry) facts.telemetryOut = { proposals: tm.foldLabels(all, facts.telemetry) };
    if (facts.telemetry) budget.spend('telemetry', tm.telemetryBlock(facts.telemetry, all).classifier?.costUsd);
    facts.budget = budget.summary();
    await writeReport({ dir, scenario, issues, findings: all, timeline, started, tester, facts, logLines, coverage });
    if (opt.verify !== 'no' || opt.file !== 'no') {
      const review = { ...REVIEW, ask: budget.verifier() };
      await reviewFindings({ ...review, dir, scenario, findings: all, timeline, log, verify: opt.verify !== 'no', file: opt.file !== 'no' });
      facts.budget = budget.summary();
      await writeReport({ dir, scenario, issues, findings: all, timeline, started, tester, facts, logLines, coverage });
    }
    // The run’s record for a refit (tools/uat-stats.mjs), so it needn’t parse the report.
    writeJsonAtomic(join(dir, 'run.json'), {
      ...runRecord({ root: ROOT, dir, scenario, name, opt, started, steps: timeline.length, cap: steps, startPhase: startPhase + 1, tester, facts, coverage }),
      ...(facts.telemetry ? { telemetry: tm.telemetryBlock(facts.telemetry, all) } : {}),
      ...(facts.budget ? { budget: facts.budget } : {}),
    });
  } finally {
    unwatch();
    await stop();
  }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url))
  (opt.recheck ? recheck(opt.recheck, { root: ROOT, opt, review: REVIEW }) : main()).catch((e) => {
    console.error(`UAT run failed: ${e.stack ?? e.message}`);
    // A run stopped by a signal exits as stopped (130, tools/uat/stop.mjs), whatever it failed with meanwhile.
    process.exit(process.exitCode || 1);
  });
