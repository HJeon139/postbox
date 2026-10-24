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

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { launch, sleep } from './cdp.mjs';
import { MID_TURN, runChecks, waitingOnYou } from './uat/checks.mjs';
import { driver, JOBS_ANSWERS } from './uat/driver.mjs';
import { followEvents, readHistory } from './uat/history.mjs';
import { cleanUp, endHosts } from './uat/hosts-end.mjs';
import { hostMode } from './uat/hosts-options.mjs';
import { createHostRun, readHosts, startHosts } from './uat/hosts-run.mjs';
import { forHosts } from './uat/hosts-scenario.mjs';
import { afterStep, fault, sample } from './uat/hosts-watch.mjs';
import { startPostbox } from './uat/postbox.mjs';
import { presetFindings } from './uat/regressions.mjs';
import { agentsSpent, writeReport } from './uat/report.mjs';
import { reviewFindings } from './uat/review.mjs';
import { gitInfo, readRun, runRecord, runsRoot, writeJsonAtomic } from './uat/runs.mjs';
import { compatBackends, isTargeted, parseScenario, phaseCap, releaseGate, stepCap } from './uat/scenario.mjs';
import { seedAgents } from './uat/seed.mjs';
import { createTester, systemPrompt, unaddressed } from './uat/tester.mjs';
import { gapFinding, phaseGoals, unknownTriggers } from './uat/triggers.mjs';
import { withoutPreset } from './uat/verdicts.mjs';

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
    // Host mode (#120): hosts as ssh destinations (host1, host2… in order), their settings as hostN.key=value, and
    // where agents run, as handle=hostN or handle=local over the scenario’s `- place:` (tools/uat/hosts-options.mjs).
    host: { type: 'string', multiple: true },
    'host-setting': { type: 'string', multiple: true },
    place: { type: 'string', multiple: true },
    // The run’s whole spend, agents and tester, in dollars: the run stops before a step that would start past it.
    'run-budget': { type: 'string' },
  },
});

// What verifying and filing need from here (tools/uat/review.mjs).
const REVIEW = { root: ROOT, testerModel: opt['tester-model'] };

// ── The person’s own Claude Code setup, to spot it leaking into agents (or missing from them) ─────────────

function userSetup(workspace) {
  const out = { userMcpServers: [], userRulesMarker: null };
  try {
    const cfg = JSON.parse(readFileSync(join(homedir(), '.claude.json'), 'utf8'));
    out.userMcpServers = [...Object.keys(cfg.mcpServers ?? {}), ...Object.keys(cfg.projects?.[workspace]?.mcpServers ?? {})];
  } catch {}
  try {
    out.userRulesMarker =
      readFileSync(join(homedir(), '.claude', 'CLAUDE.md'), 'utf8')
        .split('\n')
        .map((l) => l.replace(/^[-#*\s]+/, '').trim())
        .find((l) => l.length >= 30) ?? null;
  } catch {}
  return out;
}

const portFree = (port) =>
  new Promise((ok) => {
    const s = createServer()
      .once('error', () => ok(false))
      .once('listening', () => s.close(() => ok(true)))
      .listen(port, '127.0.0.1');
  });

/** Each agent turn’s raw stream, as recorded by the Claude Code adapter (POSTBOX_CLAUDE_RECORD), by the Kiro CLI
 * adapter (POSTBOX_KIRO_RECORD) in streams/kiro/, or by the Antigravity CLI adapter (POSTBOX_AGY_RECORD) in streams/agy/.
 * A file is named for when its turn’s process started, and its last write is when that process last said anything (#126). */
function readStreams(folder) {
  if (!existsSync(folder)) return [];
  return readdirSync(folder)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => ({
      handle: f.replace(/^\d+-/, '').replace(/\.jsonl$/, ''),
      started: Number(/^(\d+)-/.exec(f)?.[1]) || undefined,
      ended: statSync(join(folder, f)).mtimeMs,
      events: readFileSync(join(folder, f), 'utf8')
        .split('\n')
        .filter(Boolean)
        .flatMap((l) => {
          try {
            return [JSON.parse(l)];
          } catch {
            return [];
          }
        }),
    }));
}

/** The agents’ own Claude Code transcripts, where injected reminders and settings show up. */
function readTranscripts(facts, workspace) {
  return facts.threads
    .flatMap((t) => facts.state.threads[t]?.members ?? [])
    .map((id) => facts.state.sessions[id])
    .filter((se) => se?.backendState?.claudeSessionId)
    .map((se) => ({ handle: se.handle, file: transcriptOf(workspace, se.backendState.claudeSessionId) }))
    .filter((t) => existsSync(t.file))
    .map((t) => ({ handle: t.handle, lines: readFileSync(t.file, 'utf8').split('\n') }));
}

const transcriptOf = (cwd, id) => join(homedir(), '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`);

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
  // A release-only backend (the Antigravity CLI, on a free tier) runs only in a release run; otherwise Postbox starts
  // without it, so the tester can’t put an agent on it from a sheet either.
  const gate = releaseGate(scenario, { release: opt.release });
  if (gate.error) throw new Error(gate.error);
  const unknown = unknownTriggers(scenario);
  if (unknown.length) throw new Error(`This scenario names triggers that don’t exist: ${unknown.join(', ')}. See tools/uat/triggers.mjs.`);
  const steps = stepCap(scenario, opt.steps);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
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
    },
    log,
  });
  const { api } = postbox;
  // What happened, in order, from the first event: the checks for #123 need history the state doesn’t keep.
  const history = followEvents(origin);
  const page = await launch({ port: Number(opt['chrome-port']) });
  // Host mode’s record of its hosts (tools/uat/hosts-run.mjs), which its checks and triggers read as facts.hosts.
  const hr = hosts.length ? createHostRun({ hosts, placement, launcher: scenario.launcher, root: ROOT, stamp, data: paths.data, log }) : null;
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
    ...(hr ? { hosts: hr.record } : {}),
  };
  try {
    await page.size(1440, 1000, { theme: 'light' });
    await page.goto(`${origin}/`);
    const state0 = (await api('/api/state')).state;
    facts.startPersonas = Object.values(state0.personas).filter((p) => !p.retired);
    const d = driver(page);
    await d.newProject(scenario.project, paths.workspace);
    if (hr) await startHosts(hr, { postbox, api, kit: d.kit, dir, project: scenario.project });
    const hash = await d.newConversation(scenario.project, scenario.conversation, scenario.agents);
    const mainThread = /#\/t\/([^/]+)/.exec(hash)?.[1];
    if (!mainThread) throw new Error(`Starting the conversation didn’t open it (at ${hash}).`);
    log(`Conversation ${mainThread} started with @${scenario.agents.join(', @')}.`);

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
      facts.ui.headerText = await page.evaluate(`document.querySelector('.rail .agents-sec')?.innerText ?? ''`);
      // The Agents section and the top bar (#105): who has a row, and whether the title or project is cut.
      facts.ui.agentRows = await page.evaluate(
        `[...document.querySelectorAll('.agent-rows .agent-btn')].map((b) => (/@([\\w-]+)/.exec(b.textContent) ?? [])[1]).filter(Boolean)`,
      );
      facts.ui.topbarCut = await page.evaluate(
        `innerWidth >= 1200 && [...document.querySelectorAll('header.topbar .title, header.topbar .crumb')].some((n) => n.scrollWidth > n.clientWidth + 1)`,
      );
      facts.ui.reviewRawRows = await page.evaluate(
        `Object.fromEntries([...document.querySelectorAll('[data-key]')].filter((n) => n.querySelector(':scope .rv-doc')).map((n) => [n.dataset.key, n.querySelector('.rv-doc').innerText.split('\\n').filter((l) => /^\\s*\\|.*\\|\\s*$/.test(l)).length]))`,
      );
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

    /** Waits until no agent under test is working, sampling what the screen says meanwhile. */
    const settle = async () => {
      const end = Date.now() + Number(opt['turn-timeout']) * 1000;
      let calm = 0;
      while (Date.now() < end) {
        await sleep(1500);
        const st = (await api('/api/state')).state;
        const ids = threadsUnderTest(st);
        const sessions = ids
          .flatMap((t) => st.threads[t]?.members ?? [])
          .map((id) => st.sessions[id])
          .filter(Boolean);
        const working = sessions.filter((se) => ['think', 'tool', 'gen'].includes(se.state));
        const checking = Object.values(st.apps).some((a) => ids.includes(a.threadId) && ['pending', 'fixing'].includes(a.check?.status));
        const thinking = working.filter((se) => se.state !== 'gen').map((se) => se.handle);
        if (thinking.length) facts.samples.push({ busy: thinking, rows: (await d.working()).length });
        if (working.length) await midTurnChecks(st);
        calm = working.length || checking ? 0 : calm + 1;
        if (calm >= 2) return null;
      }
      await d.stopAll();
      return `An agent was still working after ${opt['turn-timeout']} s, so the run pressed Stop.`;
    };

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
      const timedOut = await settle();
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
      const spent = agentsSpent(facts.streams) + tester.spent;
      if (spent >= Number(opt['run-budget'] ?? Infinity)) {
        log(`The run has spent $${spent.toFixed(2)} of its $${opt['run-budget']} (--run-budget), so it stops here.`);
        break;
      }
      const answer = await tester.step(prompt, system);
      goals.took(phase);
      timeline.push({ step, phase: ph.title, assessment: answer.assessment, action: answer.action });
      log(`step ${step} · ${answer.assessment}`);
      for (const f of answer.findings) {
        const k = `tester:${f.title.toLowerCase().replace(/\W+/g, '-').slice(0, 60)}`;
        if (!findings.has(k)) {
          findings.set(k, { ...f, source: 'tester', step, phase: ph.title });
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
        if (a.type === 'send') {
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
        } else if (a.type === 'send_then_stop') {
          await d.send(a.text ?? '');
          await sleep(Math.max(1, Math.min(10, a.seconds ?? 2)) * 1000);
          await d.stopAll();
          actionResult = 'Pressed Stop on the active reply.';
        } else if (a.type === 'thread') await d.replyInThread(key, a.text ?? '');
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
        else if (a.type === 'wait') await sleep(Math.min(300, a.seconds ?? 30) * 1000);
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
    await writeReport({ dir, scenario, issues, findings: all, timeline, started, tester, facts, logLines, coverage });
    if (opt.verify !== 'no' || opt.file !== 'no') {
      await reviewFindings({ ...REVIEW, dir, scenario, findings: all, timeline, log, verify: opt.verify !== 'no', file: opt.file !== 'no' });
      await writeReport({ dir, scenario, issues, findings: all, timeline, started, tester, facts, logLines, coverage });
    }
    // The run’s record for a refit (tools/uat-stats.mjs), so it needn’t parse the report.
    writeJsonAtomic(
      join(dir, 'run.json'),
      runRecord({ root: ROOT, dir, scenario, name, opt, started, steps: timeline.length, cap: steps, startPhase: startPhase + 1, tester, facts, coverage }),
    );
  } finally {
    if (hr) await cleanUp(hr).catch((e) => log(`Couldn’t clean the hosts up: ${e.message}`));
    history.close();
    await page.close().catch(() => {});
    postbox.kill();
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
  // A host-mode run’s record of its hosts (#120): its phases as it played them, and what its checks read.
  const hostsRec = readHosts(dir);
  const parsed = parseScenario(readFileSync(join(ROOT, 'tests', 'uat', 'e2e', 'scenarios', `${name}.md`), 'utf8'));
  const scenario = hostsRec ? forHosts(parsed, hostsRec.placement, hostsRec.hosts) : parsed;
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
      ...(hostsRec ? { hosts: hostsRec } : {}),
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
