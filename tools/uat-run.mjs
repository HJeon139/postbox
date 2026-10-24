// UAT, end to end. Starts a fresh Postbox with real agents, opens it in headless Chrome, and lets a tester
// model play the person through a scenario (tests/uat/e2e/scenarios/*.md): it writes messages, answers
// blocks, uses apps and topic threads, and judges every step. Deterministic checks (tools/uat/checks.mjs)
// run alongside it. The report lists every finding, and which open GitHub issues the run caught again.
//
//   node tools/uat-run.mjs --scenario scifact
//   node tools/uat-run.mjs --scenario hotpotqa --steps 30 --budget 6 --tester-model claude-opus-5-5
//
// Real agents and the tester both run on the claude CLI you’re signed in to, so a run costs real usage. A scenario
// can put agents on another backend (`- backends: critic=kiro-cli:gpt-5.6-terra`); those use that CLI’s sign-in, and
// the scenario is a compatibility run, which needs --compat. The Antigravity CLI is on a free tier, so it runs only
// for a version release: --release (releaseGate), which also counts as --compat:
//
//   node tools/uat-run.mjs --scenario mixedroom --compat
// Everything a run makes goes in uat-runs/<time>-<scenario>/ in the main checkout, or POSTBOX_UAT_RUNS (tools/uat/runs.mjs),
// ignored by git: report.md, findings.json, run.json, screenshots, each agent turn’s raw stream, and Postbox’s data.
// A run is 15 steps unless its scenario or --steps says otherwise; a targeted scenario’s phases end on their triggers
// (tools/uat/triggers.mjs). Every finding gets a verdict: the verifier’s after the run, or yours (tools/uat-verdict.mjs).

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { agyVersion, findAgy } from '../server/adapters/antigravity-cli.mjs';
import { codexModels, codexVersion, findCodex } from '../server/adapters/codex.mjs';
import { findKiro, kiroVersion } from '../server/adapters/kiro-cli.mjs';
import { launch, sleep } from './cdp.mjs';
import { agyTokens, kiroCredits, MID_TURN, runChecks, waitingOnYou } from './uat/checks.mjs';
import { driver, JOBS_ANSWERS } from './uat/driver.mjs';
import { followEvents, readHistory } from './uat/history.mjs';
import { presetFindings } from './uat/regressions.mjs';
import { reviewFindings } from './uat/review.mjs';
import { readStreams, readTranscripts, readUi, userSetup } from './uat/run-files.mjs';
import { gitInfo, readRun, runRecord, runsRoot, writeJsonAtomic } from './uat/runs.mjs';
import { compatBackends, isTargeted, parseScenario, phaseCap, releaseGate, stepCap } from './uat/scenario.mjs';
import * as tm from './uat/telemetry-run.mjs';
import { createTester, systemPrompt, unaddressed } from './uat/tester.mjs';
import { coverageSection, gapFinding, phaseGoals, unknownTriggers } from './uat/triggers.mjs';
import { sendThenStop, settle as settleTurns, WAIT_MAX_S } from './uat/turns.mjs';
import { mergePeopleVerdicts, withoutPreset } from './uat/verdicts.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const { values: opt } = parseArgs({
  options: {
    scenario: { type: 'string', default: 'scifact' },
    port: { type: 'string', default: '4310' },
    'chrome-port': { type: 'string', default: '9510' },
    // The most steps: the scenario’s own `- steps: N`, else a targeted scenario’s phase caps added up, else 15.
    steps: { type: 'string' },
    // Start at this phase (1 is the first), to rerun a later one without the earlier ones; the tester sets up what it needs.
    phase: { type: 'string', default: '1' },
    'turn-timeout': { type: 'string', default: '900' },
    budget: { type: 'string', default: '8' },
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
    // Every run records itself and saves one telemetry report (designs/telemetry-persona.md, U4); no opts out.
    telemetry: { type: 'string', default: 'yes' },
  },
});

// What verifying and filing need from here (tools/uat/review.mjs).
const REVIEW = { root: ROOT, testerModel: opt['tester-model'] };

const portFree = (port) =>
  new Promise((ok) => {
    const s = createServer()
      .once('error', () => ok(false))
      .once('listening', () => s.close(() => ok(true)))
      .listen(port, '127.0.0.1');
  });

// ── Run ────────────────────────────────────────────────────────────────────────────────────

async function main() {
  const scenarioFile = existsSync(opt.scenario) ? opt.scenario : join(ROOT, 'tests', 'uat', 'e2e', 'scenarios', `${opt.scenario}.md`);
  const scenario = parseScenario(readFileSync(scenarioFile, 'utf8'));
  const other = compatBackends(scenario);
  if (other.length && !opt.compat && !opt.release)
    throw new Error(
      `This scenario puts agents on ${other.join(' and ')}, so it’s a compatibility run, which runs only when asked: it uses that harness’s credits, and a regular pass is Claude only. Pass --compat to run it.`,
    );
  // A release-only backend (the Antigravity CLI, on a free tier) runs only in a release run; otherwise Postbox starts
  // without it, so the tester can’t put an agent on it from a sheet either.
  const gate = releaseGate(scenario, { release: opt.release });
  if (gate.error) throw new Error(gate.error);
  const unknown = unknownTriggers(scenario);
  if (unknown.length) throw new Error(`This scenario names triggers that don’t exist: ${unknown.join(', ')}. See tools/uat/triggers.mjs.`);
  const steps = stepCap(scenario, opt.steps);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const name = opt.scenario.replace(/^.*\//, '').replace(/\.md$/, '');
  const dir = join(runsRoot({ root: ROOT }), `${stamp}-${name}`);
  const paths = {
    data: join(dir, 'data'),
    workspace: join(dir, 'workspace'),
    streams: join(dir, 'streams'),
    kiroStreams: join(dir, 'streams', 'kiro'),
    agyStreams: join(dir, 'streams', 'agy'),
    codexStreams: join(dir, 'streams', 'codex'),
    shots: join(dir, 'shots'),
  };
  for (const p of Object.values(paths)) await mkdir(p, { recursive: true });
  // The workspace is a git repository of its own. It lies inside the Postbox checkout, so without one an agent’s
  // git add and commit would land in Postbox’s history; a workroom agent had to notice and make a nested repo.
  spawnSync('git', ['init', '-q', paths.workspace], { stdio: 'ignore' });
  const canaries = scenario.seed === 'canaries' ? tm.seedCanaries(paths.workspace, dir) : null;
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
  // A fresh install has one generic agent, so the scenario's agents are seeded from agents.json: every
  // persona in personas.json, since scenarios bring more agents (@critic) into topic threads than they start with.
  const personas = JSON.parse(readFileSync(join(ROOT, 'tests', 'uat', 'e2e', 'personas.json'), 'utf8'));
  let codexDefaultModel = null;
  if (Object.values(scenario.backends).some((b) => b.backend === 'codex')) {
    const v = await codexVersion(findCodex());
    if (!v) throw new Error('This scenario puts agents on Codex, and the Codex CLI is not installed here (or set POSTBOX_CODEX_BIN).');
    codexDefaultModel = (await codexModels(findCodex()))[0] ?? null;
    log(`Codex ${v}${codexDefaultModel ? ` · default model ${codexDefaultModel}` : ''}.`);
  }
  // An agent the scenario puts on another backend runs there with the model it names. A Kiro agent is Isolated: it
  // runs with Postbox’s own Kiro home, so the run never writes into the person’s ~/.kiro, and the Kiro checks can
  // tell the person’s steering and servers from Postbox’s (#57).
  const onBackend = (p) => {
    const b = scenario.backends[p.handle];
    return b
      ? {
          ...p,
          backend: b.backend,
          ...(scenario.permissionModes[p.handle] ? { permissionMode: scenario.permissionModes[p.handle] } : {}),
          ...(b.model ? { model: b.model } : b.backend === 'codex' && codexDefaultModel ? { model: codexDefaultModel } : {}),
          ...(b.backend === 'kiro-cli' ? { usesHostSetup: false } : {}),
        }
      : p;
  };
  // Claude agents run on the run’s model, unless the scenario keeps the persona’s and --force-agent-model doesn’t override it.
  const fast = (p) => {
    if ((scenario.models === 'persona' && !opt['force-agent-model']) || scenario.backends[p.handle]) return p;
    return {
      ...p,
      ...(opt['agent-model'] !== 'persona' ? { model: opt['agent-model'] } : {}),
      ...(opt['agent-effort'] !== 'persona' ? { effort: opt['agent-effort'] } : {}),
    };
  };
  const agents = [
    ...scenario.agents.map((h) => personas.find((p) => p.handle === h) ?? { handle: h }),
    ...personas.filter((p) => !scenario.agents.includes(p.handle)),
  ]
    .map(fast)
    .map(onBackend);
  if (opt.release) log('A release run: the release-only backends are on.');
  // Postbox registers the Kiro CLI only when it can run it, and seeding an agent on a backend it doesn’t have fails.
  // The same for the Antigravity CLI, which a release run alone may use (releaseGate). It always runs with the
  // person’s own agy setup: it has no Isolated mode (server/adapters/antigravity-cli.mjs).
  if (Object.values(scenario.backends).some((b) => b.backend === 'antigravity-cli')) {
    const v = await agyVersion(findAgy());
    if (!v) throw new Error('This scenario puts agents on the Antigravity CLI, and agy isn’t installed here (or set POSTBOX_AGY_BIN).');
    log(`Antigravity CLI ${v}, on a free tier: this run uses its quota.`);
  }
  if (Object.values(scenario.backends).some((b) => b.backend === 'kiro-cli')) {
    const v = await kiroVersion(findKiro());
    if (!v) throw new Error('This scenario puts agents on the Kiro CLI, and kiro-cli isn’t installed here (or set POSTBOX_KIRO_BIN).');
    log(
      `Kiro CLI ${v}: ${Object.entries(scenario.backends)
        .map(([h, b]) => `@${h} on ${b.backend}${b.model ? ` (${b.model})` : ''}`)
        .join(', ')}.`,
    );
  }
  await writeFile(join(paths.data, 'agents.json'), JSON.stringify(agents, null, 2));
  // What the agents ran on, for the report: a fast run’s findings about agent choices aren’t the default model’s.
  const agentModels = agents.map((p) => `@${p.handle} ${p.model ?? 'its default model'}${p.effort ? `, ${p.effort} effort` : ''}`).join('; ');
  log(`Agents: ${agentModels}.`);
  // The effort the scenario’s Claude agents run at, for run.json: a `- models: persona` run keeps each persona’s own.
  const efforts = [...new Set(agents.filter((p) => scenario.agents.includes(p.handle) && !scenario.backends[p.handle]).map((p) => p.effort ?? null))];
  const agentEffort = efforts.length > 1 ? efforts.map((e) => e ?? 'default').join('/') : (efforts[0] ?? null);
  const server = spawn(process.execPath, [join(ROOT, 'server', 'index.mjs'), '--port', String(port), '--data', paths.data, '--fresh'], {
    cwd: ROOT,
    env: {
      ...process.env,
      ...gate.env,
      POSTBOX_CLAUDE_RECORD: paths.streams,
      POSTBOX_KIRO_RECORD: paths.kiroStreams,
      POSTBOX_AGY_RECORD: paths.agyStreams,
      POSTBOX_CODEX_RECORD: paths.codexStreams,
      ...tm.telemetryEnv(scenario, dir, opt),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => log(`postbox: ${String(d).trim()}`));
  server.stderr.on('data', (d) => log(`postbox (stderr): ${String(d).trim()}`));
  let exited = null;
  server.on('exit', (code) => (exited = code));
  // Stopping the run stops its Postbox too, and with it the agents' turns: an orphaned server keeps agents running,
  // and spending, after the run is gone.
  for (const sig of ['SIGINT', 'SIGTERM'])
    process.once(sig, () => {
      if (exited === null) server.kill('SIGTERM');
      process.exit(130);
    });
  const api = async (p) => {
    if (exited !== null) throw new Error(`Postbox exited (code ${exited}); see run.log.`);
    return (await fetch(origin + p)).json();
  };
  for (let i = 0; ; i++) {
    try {
      await api('/api/state');
      break;
    } catch (e) {
      if (exited !== null || i > 80) throw new Error(`Postbox didn’t start: ${e.message}`);
      await sleep(250);
    }
  }
  // What happened, in order, from the first event: the checks for #123 need history the state doesn’t keep.
  const history = followEvents(origin);
  const page = await launch({ port: Number(opt['chrome-port']) });
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
    // stale: the page’s notices that Postbox refused an answer as stale (#123); interrupts: how the runner answered
    // Stop’s question about background jobs (#126). The triggers read both. panels, panes and drafts: what the Agents
    // section, the right pane and full screen showed (#105, #146).
    probes: { fullScreen: [], attachments: [], answers: [], stale: [], interrupts: [], panels: [], panes: [], drafts: [] },
    samples: [],
    ui: {},
    ...userSetup(paths.workspace),
  };
  try {
    await page.size(1440, 1000, { theme: 'light' });
    await page.goto(`${origin}/`);
    const state0 = (await api('/api/state')).state;
    facts.startPersonas = Object.values(state0.personas).filter((p) => !p.retired);
    const d = driver(page);
    await d.newProject(scenario.project, paths.workspace);
    const hash = await d.newConversation(scenario.project, scenario.conversation, scenario.agents);
    const mainThread = /#\/t\/([^/]+)/.exec(hash)?.[1];
    if (!mainThread) throw new Error(`Starting the conversation didn’t open it (at ${hash}).`);
    log(`Conversation ${mainThread} started with @${scenario.agents.join(', @')}.`);
    const { td, tel } = await tm.startTelemetry(page, { scenario, opt, log });

    const tester = createTester({ cwd: dir, model: opt['tester-model'], budgetUsd: Number(opt.budget), log });
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

    const observe = async () => {
      const out = [];
      const items = await d.items();
      for (const it of items) {
        if (!labels.has(it.key)) {
          const l = `I${labels.size + 1}`;
          labels.set(it.key, l);
          keys.set(l, it.key);
        }
        if (seen.get(it.key) === it.text) continue;
        const changed = seen.has(it.key);
        seen.set(it.key, it.text);
        const label = labels.get(it.key);
        const lines = [
          `[${label}] ${changed ? '(changed) ' : ''}${it.where}${it.block ? ` · ${it.block}` : ''}${it.app ? ' · agent app' : ''}${it.diagram ? ' · diagram' : ''}`,
        ];
        lines.push(it.text.length > 1800 ? `${it.text.slice(0, 1800)}…` : it.text);
        if (it.buttons.length) lines.push(`Buttons: ${it.buttons.join(' | ')}`);
        if (it.fields.length) lines.push(`Fields: ${it.fields.join(' | ')}`);
        if (it.block || it.app || it.diagram || it.math) {
          const shot = await d.shotItem(it.key, join(paths.shots, `${String(timeline.length).padStart(2, '0')}-${label}.png`));
          if (shot) lines.push(`Screenshot: ${relative(dir, shot)}`);
        }
        if (it.app) {
          const inside = await d.appInside(it.key);
          facts.apps[it.key] = inside;
          if (inside) lines.push(`Inside the app: ${inside.text.slice(0, 700)}`);
          else lines.push('Inside the app: (couldn’t be read)');
        }
        out.push(lines.join('\n'));
      }
      const st = facts.state;
      const states = facts.threads
        .flatMap((t) => st.threads[t]?.members ?? [])
        .map((id) => st.sessions[id])
        .filter(Boolean)
        .map((se) => `@${se.handle} in “${st.threads[se.threadId]?.title}”: ${se.state}${se.needs ? ` (needs you: ${se.needs.text})` : ''}`);
      return { items: out, states };
    };

    for (let step = 1; step <= steps; step++) {
      const timedOut = await settle(true);
      await refreshFacts();
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
      // Moving on, or waiting while no agent works, past something that waits on the person: say so once, and ask
      // again. A second try with the same list goes ahead, so a run can’t loop on a block it can’t answer.
      const idle = !obs.states.some((s) => /: (?:think|tool|gen)\b/.test(s));
      if (waiting.length && (a.type === 'next_phase' || a.type === 'done' || (a.type === 'wait' && idle)) && pushedBack !== waiting.join('\n')) {
        pushedBack = waiting.join('\n');
        actionError = `Not yet: ${waiting.length === 1 ? 'this is' : 'these are'} still waiting on you: ${waiting.join('; ')}. Answer ${waiting.length === 1 ? 'it' : 'them'} first.`;
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
        } else if (a.type === 'wait') await sleep(Math.min(WAIT_MAX_S, a.seconds ?? 30) * 1000);
        else if (a.type === 'stop') await d.stopAll();
        // Stop or Send now while the turn this action started is running (#126).
        if (a.interrupt && ['send', 'thread', 'act', 'review'].includes(a.type)) {
          // Where the turn runs: a reply in a thread, or an answer to a block in the panel, works there.
          const panel = a.type === 'thread' || (key ? await d.inPanel(key) : false);
          const said = await d.interrupt(a.interrupt, { panel, onWait: () => midTurnChecks(), answer: () => answerMidTurn(a.interrupt) });
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
    // After the last step, no agent takes another turn: the runner’s 🚩s and its report (U4).
    if (tm.runnerRecords(scenario, opt)) await tm.finishTelemetry({ td, flags: tel.flags, dir, data: paths.data, main: mainThread, shown: tel.shown, log });
    await refreshFacts();
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
    await writeReport({ dir, scenario, issues, findings: all, timeline, started, tester, facts, logLines, coverage });
    if (opt.verify !== 'no' || opt.file !== 'no') {
      await reviewFindings({ ...REVIEW, dir, scenario, findings: all, timeline, log, verify: opt.verify !== 'no', file: opt.file !== 'no' });
      await writeReport({ dir, scenario, issues, findings: all, timeline, started, tester, facts, logLines, coverage });
    }
    // The run’s record for a refit (tools/uat-stats.mjs), so it needn’t parse the report.
    writeJsonAtomic(join(dir, 'run.json'), {
      ...runRecord({ root: ROOT, dir, scenario, name, opt, started, steps: timeline.length, cap: steps, startPhase: startPhase + 1, tester, facts, coverage }),
      ...(facts.telemetry ? { telemetry: tm.telemetryBlock(facts.telemetry, all) } : {}),
    });
  } finally {
    history.close();
    await page.close().catch(() => {});
    server.kill();
  }
}

// ── Report ─────────────────────────────────────────────────────────────────────────────────

async function writeReport({ dir, scenario, issues, findings, timeline, started, tester, facts, logLines, coverage = [], rechecked = false }) {
  const title = (n) => issues.find((i) => i.number === n)?.title ?? '(closed, or not in the list)';
  const agentCost = facts.streams.flatMap((s) => s.events.filter((e) => e.type === 'result')).reduce((a, e) => a + (e.total_cost_usd ?? 0), 0);
  // Kiro reports credits, not dollars: they’re listed beside the agents’ cost when a run had Kiro turns.
  const credits = kiroCredits(facts.kiroStreams ?? []);
  // Antigravity reports tokens, and its free tier is what a release run spends (#143).
  const tokens = agyTokens(facts.agyStreams ?? []);
  const usage = `Usage: agents $${agentCost.toFixed(2)}${credits ? ` and ${credits.toFixed(2)} Kiro credits` : ''}${tokens ? ` and ${tokens.toLocaleString('en-US')} Antigravity tokens` : ''}, tester $${tester.spent.toFixed(2)}.${facts.agentModels ? ` Agents: ${facts.agentModels}.` : ''}`;
  const caught = new Map();
  for (const f of findings) if (f.issue) caught.set(f.issue, [...(caught.get(f.issue) ?? []), f]);
  const { CHECKS } = await import('./uat/checks.mjs');
  const watched = [...new Set(CHECKS.map((c) => c.issue).filter(Boolean))].sort((a, b) => a - b);
  const esc = (s) =>
    String(s ?? '')
      .replace(/\|/g, '\\|')
      .replace(/\n/g, ' ');
  const md = [
    `# UAT: ${scenario.title}`,
    '',
    rechecked
      ? `Run on ${new Date(started).toISOString().slice(0, 16).replace('T', ' ')}, ${timeline.length} steps; checks rerun over its saved data on ${new Date().toISOString().slice(0, 16).replace('T', ' ')}. ${usage}`
      : `Run on ${new Date(started).toISOString().slice(0, 16).replace('T', ' ')}, ${Math.round((Date.now() - started) / 60000)} min, ${timeline.length} steps. ${usage}`,
    '',
    // What the run left unanswered: an agent that asked is stuck on it, so a run should end with none.
    ...(() => {
      const left = facts.state ? waitingOnYou(facts.state, facts.threads ?? []) : [];
      return left.length ? [`**Left waiting on you:** ${left.map((w) => w.what).join('; ')}.`, ''] : [];
    })(),
    // A targeted run says first which fixes it reached, and which it didn’t test.
    ...coverageSection(coverage, { rechecked }),
    '## Known issues caught again',
    '',
    `${caught.size} open issues reproduced. The checks watch ${watched.length} issues; the tester can match any open issue.`,
    '',
    '| Issue | Title | Caught by | Evidence |',
    '|---|---|---|---|',
    ...[...caught.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(
        ([n, fs]) =>
          `| #${n} | ${esc(title(n))} | ${[...new Set(fs.map((f) => (f.source === 'check' ? `check ${f.check}` : 'tester')))].join(', ')} | ${esc(fs[0].evidence).slice(0, 220)} |`,
      ),
    '',
    '### Watched by a check, not seen this run',
    '',
    watched
      .filter((n) => !caught.has(n))
      .map((n) => `- #${n} ${title(n)}`)
      .join('\n') || '- None.',
    '',
    '## New findings',
    '',
    'Check each against its screenshot before filing; a verdict records what a review found.',
    '',
    '| Severity | Category | Component | Finding | Evidence | Source | Verdict |',
    '|---|---|---|---|---|---|---|',
    ...findings
      .filter((f) => !f.issue && f.verdict !== 'harness')
      .map(
        (f) =>
          `| ${f.severity ?? '—'} | ${f.category ?? '—'} | ${esc(f.component ?? f.check)} | ${esc(f.title)} | ${esc(f.evidence).slice(0, 260)} | ${f.source} (step ${f.step}) | ${f.filed ? `filed #${f.filed}` : f.duplicateOf ? `duplicate of #${f.duplicateOf}` : esc(f.verdict ?? 'not reviewed')}${f.verdictBy ? ` (${f.verdictBy})` : ''}${f.note ? `: ${esc(f.note)}` : ''} |`,
      ),
    '',
    ...(findings.some((f) => f.verdict === 'harness')
      ? [
          '### The harness’s own problems',
          '',
          'Findings a review traced to the UAT harness, not to Postbox.',
          '',
          ...findings.filter((f) => f.verdict === 'harness').map((f) => `- **${esc(f.title)}.** ${esc(f.note ?? '')}`),
          '',
        ]
      : []),
    '## Timeline',
    '',
    ...timeline.map((t) => `${t.step}. **${t.phase}.** ${t.assessment} Next: \`${JSON.stringify(t.action)}\``),
    '',
    'Screenshots are in `shots/`, each agent turn’s raw stream in `streams/`, and the full log in `run.log`.',
    '',
  ].join('\n');
  await writeFile(join(dir, 'report.md'), md);
  keepPeopleVerdicts(findings, join(dir, 'findings.json'));
  writeJsonAtomic(join(dir, 'findings.json'), {
    scenario: scenario.title,
    started,
    testerSpent: tester.spent,
    findings,
    timeline,
    probes: facts.probes,
    samples: facts.samples,
    coverage,
    ...(facts.telemetryOut ? { telemetry: facts.telemetryOut } : {}),
  });
  if (rechecked) await writeFile(join(dir, 'run.log'), `${readFileSync(join(dir, 'run.log'), 'utf8')}${logLines.join('\n')}\n`);
  else await writeFile(join(dir, 'run.log'), `${logLines.join('\n')}\n`);
  console.log(
    `\nReport: ${join(dir, 'report.md')} · ${caught.size} known issues caught again · ${findings.filter((f) => !f.issue && f.verdict !== 'harness').length} new findings`,
  );
}

/**
 * A verdict a person or a reviewer recorded in findings.json (tools/uat-verdict.mjs) while this process held the
 * findings in memory, such as during a recheck’s verification, is kept rather than written over.
 * @param {any[]} findings  @param {string} file
 */
function keepPeopleVerdicts(findings, file) {
  if (!existsSync(file)) return;
  try {
    mergePeopleVerdicts(findings, JSON.parse(readFileSync(file, 'utf8')).findings ?? []);
  } catch (e) {
    console.log(`Couldn’t read ${file} to keep the verdicts in it: ${e.message}`);
  }
}

// ── Recheck ──────────────────────────────────────────────────────────────────────────────────
// Runs the checks again over a finished run’s saved data (no agents, no tester), for when the checks or the
// driver improved. Tester findings and the timeline are kept; check findings are recomputed.

const LIVE_ONLY = new Set([
  'fresh-install-agents',
  'full-screen-noop',
  'image-not-shown',
  'silent-while-working',
  'agents-section-members',
  'topbar-title-cut',
]);

async function recheck(dir) {
  // A run folder, or a run’s name in the runs folder.
  dir = existsSync(dir) ? resolve(dir) : join(runsRoot({ root: ROOT }), dir);
  const saved = JSON.parse(readFileSync(join(dir, 'findings.json'), 'utf8'));
  // Its record before the report is rewritten: the minutes it took are only in the first report.
  const record = readRun(dir);
  const name = existsSync(join(dir, 'run.json')) && record?.scenario ? record.scenario : dir.replace(/^.*-(\w+)$/, '$1');
  const scenario = parseScenario(readFileSync(join(ROOT, 'tests', 'uat', 'e2e', 'scenarios', `${name}.md`), 'utf8'));
  const port = Number(opt.port);
  if (!(await portFree(port))) throw new Error(`Port ${port} is in use. Pick another with --port.`);
  const server = spawn(process.execPath, [join(ROOT, 'server', 'index.mjs'), '--port', String(port), '--data', join(dir, 'data')], {
    cwd: ROOT,
    env: { ...process.env, POSTBOX_BACKENDS: 'mock' },
    stdio: 'ignore',
  });
  const origin = `http://127.0.0.1:${port}`;
  const page = await launch({ port: Number(opt['chrome-port']) });
  try {
    for (let i = 0; i < 80; i++) {
      try {
        await fetch(`${origin}/api/state`);
        break;
      } catch {
        await sleep(250);
      }
    }
    const state = (await (await fetch(`${origin}/api/state`)).json()).state;
    const main = Object.values(state.threads).find((t) => t.title === scenario.conversation && t.kind !== 'topic');
    if (!main) throw new Error(`No conversation called “${scenario.conversation}” in that run.`);
    await page.size(1440, 1000, { theme: 'light' });
    await page.goto(`${origin}/?recheck=1#/t/${main.id}`);
    await sleep(1500);
    const d = driver(page);
    const facts = {
      state,
      threads: [
        main.id,
        ...Object.values(state.threads)
          .filter((t) => t.parentId === main.id)
          .map((t) => t.id),
      ],
      startPersonas: [],
      streams: readStreams(join(dir, 'streams')),
      kiroStreams: readStreams(join(dir, 'streams', 'kiro')),
      agyStreams: readStreams(join(dir, 'streams', 'agy')),
      codexStreams: readStreams(join(dir, 'streams', 'codex')),
      events: readHistory(dir),
      console: page.logs,
      apps: {},
      probes: { fullScreen: [], attachments: [], answers: [], ...(saved.probes ?? {}) },
      samples: saved.samples ?? [],
      ui: {},
      ...userSetup(join(dir, 'workspace')),
    };
    facts.transcripts = readTranscripts(facts, join(dir, 'workspace'));
    for (const it of await d.items()) if (it.app) facts.apps[it.key] = await d.appInside(it.key);
    facts.ui.headerText = await page.evaluate(`document.querySelector('.rail .agents-sec')?.innerText ?? ''`);
    facts.ui.reviewRawRows = await page.evaluate(
      `Object.fromEntries([...document.querySelectorAll('[data-key]')].filter((n) => n.querySelector(':scope .rv-doc')).map((n) => [n.dataset.key, n.querySelector('.rv-doc').innerText.split('\\n').filter((l) => /^\\s*\\|.*\\|\\s*$/.test(l)).length]))`,
    );
    const kept = saved.findings.filter((f) => f.source === 'tester');
    const checks = runChecks(facts)
      .filter((f) => !LIVE_ONLY.has(f.check))
      .map((f) => ({ ...f, source: 'check', step: 'recheck' }));
    // Checks that read the live run (the fresh install, UI probes, samples while agents worked) can’t run
    // again; their findings, and the run’s own (a turn past the time limit), are kept as they were.
    // A check’s own preset is set again below, for these as for the recomputed ones (#213).
    const live = saved.findings.filter((f) => f.source === 'run' || (f.source === 'check' && LIVE_ONLY.has(f.check))).map(withoutPreset);
    const gh = spawnSync('gh', ['issue', 'list', '--state', 'all', '--limit', '300', '--json', 'number,title'], { cwd: ROOT, encoding: 'utf8' });
    const issues = gh.status === 0 ? JSON.parse(gh.stdout) : [];
    // Verdicts and filed issue numbers from earlier reviews carry over to the recomputed findings. A check’s own
    // preset doesn’t: it’s set again below, and a match to an issue closed since isn’t preset (#213).
    const before = new Map(saved.findings.filter((f) => f.source === 'check').map((f) => [`${f.check}:${f.key}`, f]));
    const carried = [
      'step',
      'phase',
      'filed',
      'regression',
      'regressionNote',
      'regressionComment',
      'verdict',
      'verdictBy',
      'verdictAt',
      'verdicts',
      'note',
      'duplicateOf',
    ];
    for (const c of checks) {
      const b = before.get(`${c.check}:${c.key}`);
      // Its step too: the refit counts a finding at the step it was first seen.
      if (b) for (const [k, v] of Object.entries(withoutPreset(b))) if (carried.includes(k) && v !== undefined) c[k] = v;
    }
    // Coverage is read again from the whole run: a phase’s triggers either happened in it or didn’t. A gap saved
    // before keeps its verdict if it’s still a gap.
    // A run that started at a later phase (--phase) skipped the ones before it: they aren’t gaps.
    const start = Math.max(0, (Number(record?.startPhase) || 1) - 1);
    const goals = phaseGoals(scenario, { cap: phaseCap, start, log: (l) => console.log(l) });
    goals.observe(facts, null);
    const coverage = goals.coverage();
    const gapsBefore = new Map(live.filter((f) => f.check === 'coverage-gap').map((f) => [f.key, f]));
    const gaps = scenario.phases.flatMap((ph, i) => {
      const missing = coverage.filter((c) => c.phase === i + 1 && c.hit === false && !c.skipped).map((c) => c.trigger);
      if (!missing.length) return [];
      const g = { ...gapFinding({ phase: i + 1, title: ph.title, missing, why: 'Over the whole run,' }), step: 'recheck', phase: ph.title };
      return [{ ...g, ...(gapsBefore.get(g.key)?.verdictBy === 'person' || gapsBefore.get(g.key)?.verdictBy === 'reviewer' ? gapsBefore.get(g.key) : {}) }];
    });
    const findings = [...checks, ...live.filter((f) => f.check !== 'coverage-gap'), ...gaps, ...kept];
    presetFindings(findings, { root: ROOT, commit: record?.commit ?? null });
    const report = () =>
      writeReport({
        dir,
        scenario,
        issues,
        findings,
        timeline: saved.timeline,
        started: saved.started ?? Date.now(),
        tester: { spent: saved.testerSpent ?? 0 },
        facts,
        logLines: [`Rechecked ${new Date().toISOString()} with the current checks and driver.`],
        coverage,
        rechecked: true,
      });
    await report();
    // A recheck verifies only when it files, unless asked: --recheck --file no makes no model call.
    const verify = opt.verify ? opt.verify !== 'no' : opt.file !== 'no';
    if (verify || opt.file !== 'no') {
      await reviewFindings({
        ...REVIEW,
        dir,
        scenario,
        findings,
        timeline: saved.timeline,
        log: (l) => console.log(l),
        verify,
        file: opt.file !== 'no',
      });
      await report();
    }
    // A run from before run.json gets one, from what its report and streams say.
    const { dir: _d, findings: _f, ...kept2 } = record ?? {};
    writeJsonAtomic(join(dir, 'run.json'), { ...kept2, scenario: name, kind: isTargeted(scenario) ? 'targeted' : 'exploratory', coverage });
  } finally {
    await page.close().catch(() => {});
    server.kill();
  }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url))
  (opt.recheck ? recheck(opt.recheck) : main()).catch((e) => {
    console.error(`UAT run failed: ${e.stack ?? e.message}`);
    process.exit(1);
  });
