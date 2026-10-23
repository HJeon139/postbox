// UAT, end to end. Starts a fresh Postbox with real agents, opens it in headless Chrome, and lets a tester
// model play the person through a scenario (tests/uat/e2e/scenarios/*.md): it writes messages, answers
// blocks, uses apps and topic threads, and judges every step. Deterministic checks (tools/uat/checks.mjs)
// run alongside it. The report lists every finding, and which open GitHub issues the run caught again.
//
//   node tools/uat-run.mjs --scenario scifact
//   node tools/uat-run.mjs --scenario hotpotqa --steps 30 --budget 6 --tester-model claude-opus-5-5
//
// Real agents and the tester both run on the claude CLI you’re signed in to, so a run costs real usage. A scenario
// can put agents on another backend (`- backends: critic=kiro-cli:gpt-5.6-terra`); those use that CLI’s sign-in.
// Everything a run makes goes in uat-runs/<time>-<scenario>/ (ignored by git): report.md, findings.json,
// screenshots, each agent turn’s raw stream, and Postbox’s data.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { findKiro, kiroVersion } from '../server/adapters/kiro-cli.mjs';
import { launch, sleep } from './cdp.mjs';
import { kiroCredits, runChecks, waitingOnYou } from './uat/checks.mjs';
import { driver } from './uat/driver.mjs';
import { parseScenario } from './uat/scenario.mjs';
import { askOnce, createTester, systemPrompt, unaddressed, VERIFY_SCHEMA, verifyPrompt } from './uat/tester.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const { values: opt } = parseArgs({
  options: {
    scenario: { type: 'string', default: 'scifact' },
    port: { type: 'string', default: '4310' },
    'chrome-port': { type: 'string', default: '9510' },
    steps: { type: 'string', default: '40' },
    // Start at this phase (1 is the first), to rerun a later one without the earlier ones; the tester sets up what it needs.
    phase: { type: 'string', default: '1' },
    'turn-timeout': { type: 'string', default: '900' },
    budget: { type: 'string', default: '8' },
    'tester-model': { type: 'string', default: 'claude-sonnet-5-5' },
    recheck: { type: 'string' },
    // After a run, verify new findings and file the confirmed ones that no open issue covers. --file no skips it.
    file: { type: 'string', default: 'yes' },
  },
});

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

/** Each agent turn’s raw stream, as recorded by the Claude Code adapter (POSTBOX_CLAUDE_RECORD), or by the Kiro CLI
 * adapter (POSTBOX_KIRO_RECORD) in streams/kiro/. */
function readStreams(folder) {
  if (!existsSync(folder)) return [];
  return readdirSync(folder)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => ({
      handle: f.replace(/^\d+-/, '').replace(/\.jsonl$/, ''),
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
  const scenario = parseScenario(readFileSync(scenarioFile, 'utf8'));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const name = opt.scenario.replace(/^.*\//, '').replace(/\.md$/, '');
  const dir = join(ROOT, 'uat-runs', `${stamp}-${name}`);
  const paths = {
    data: join(dir, 'data'),
    workspace: join(dir, 'workspace'),
    streams: join(dir, 'streams'),
    kiroStreams: join(dir, 'streams', 'kiro'),
    shots: join(dir, 'shots'),
  };
  for (const p of Object.values(paths)) await mkdir(p, { recursive: true });
  const logLines = [];
  const log = (line) => {
    const l = `[${new Date().toLocaleTimeString('en-US', { hour12: false })}] ${line}`;
    logLines.push(l);
    console.log(l);
  };
  const started = Date.now();
  log(`UAT “${scenario.title}” → ${relative(ROOT, dir)}`);

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
  // An agent the scenario puts on another backend runs there with the model it names. A Kiro agent is Isolated: it
  // runs with Postbox’s own Kiro home, so the run never writes into the person’s ~/.kiro, and the Kiro checks can
  // tell the person’s steering and servers from Postbox’s (#57).
  const onBackend = (p) => {
    const b = scenario.backends[p.handle];
    return b ? { ...p, backend: b.backend, ...(b.model ? { model: b.model } : {}), ...(b.backend === 'kiro-cli' ? { usesHostSetup: false } : {}) } : p;
  };
  const agents = [
    ...scenario.agents.map((h) => personas.find((p) => p.handle === h) ?? { handle: h }),
    ...personas.filter((p) => !scenario.agents.includes(p.handle)),
  ].map(onBackend);
  // Postbox registers the Kiro CLI only when it can run it, and seeding an agent on a backend it doesn’t have fails.
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
  const server = spawn(process.execPath, [join(ROOT, 'server', 'index.mjs'), '--port', String(port), '--data', paths.data, '--fresh'], {
    cwd: ROOT,
    env: { ...process.env, POSTBOX_CLAUDE_RECORD: paths.streams, POSTBOX_KIRO_RECORD: paths.kiroStreams },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => log(`postbox: ${String(d).trim()}`));
  server.stderr.on('data', (d) => log(`postbox (stderr): ${String(d).trim()}`));
  let exited = null;
  server.on('exit', (code) => (exited = code));
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
  const page = await launch({ port: Number(opt['chrome-port']) });
  const findings = new Map(); // key → finding
  const timeline = [];
  const facts = {
    state: null,
    threads: [],
    startPersonas: [],
    streams: [],
    kiroStreams: [],
    transcripts: [],
    console: page.logs,
    apps: {},
    probes: { fullScreen: [], attachments: [] },
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

    const tester = createTester({ cwd: dir, model: opt['tester-model'], budgetUsd: Number(opt.budget), log });
    const system = systemPrompt({ scenario, issues });
    const labels = new Map(); // item key → I1…
    const keys = new Map(); // I1… → item key
    const seen = new Map(); // item key → text last shown to the tester
    let phase = Math.min(Math.max(Number(opt.phase) - 1 || 0, 0), scenario.phases.length - 1);
    if (phase) log(`Starting at phase ${phase + 1}: ${scenario.phases[phase].title}.`);
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
      facts.transcripts = readTranscripts(facts, paths.workspace);
      facts.ui.headerText = await page.evaluate(`document.querySelector('.rail .agents-sec')?.innerText ?? ''`);
      facts.ui.reviewRawRows = await page.evaluate(
        `Object.fromEntries([...document.querySelectorAll('[data-key]')].filter((n) => n.querySelector(':scope .rv-doc')).map((n) => [n.dataset.key, n.querySelector('.rv-doc').innerText.split('\\n').filter((l) => /^\\s*\\|.*\\|\\s*$/.test(l)).length]))`,
      );
    };
    const newFindings = () => {
      const fresh = [];
      for (const f of runChecks(facts)) {
        const k = `${f.check}:${f.key}`;
        if (findings.has(k)) continue;
        const x = { ...f, source: 'check', step: timeline.length, phase: scenario.phases[phase]?.title };
        findings.set(k, x);
        fresh.push(x);
        log(`check ${f.check}${f.issue ? ` (#${f.issue})` : ''}: ${f.title}`);
      }
      return fresh;
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

    for (let step = 1; step <= Number(opt.steps); step++) {
      const timedOut = await settle();
      await refreshFacts();
      if (timedOut)
        findings.set(`stuck:${step}`, { source: 'run', check: 'stuck', issue: null, title: 'An agent turn ran past the time limit', evidence: timedOut, step });
      const obs = await observe();
      const fresh = newFindings();
      const ph = scenario.phases[phase];
      // What “needs you” counts, every step, whether or not it changed: an old review draft stays on the list.
      const waiting = waitingOnYou(facts.state, facts.threads).map((w) => {
        const label = w.itemId ? labels.get(w.itemId) : null;
        const where = facts.state.threads[w.threadId];
        return `${label ? `[${label}] ` : ''}${w.what}${where && w.threadId !== mainThread ? ` (in the thread “${where.title}”${label ? '' : ', not on screen: open it'})` : ''}`;
      });
      const prompt = [
        `Step ${step} of at most ${opt.steps}. Phase ${phase + 1} of ${scenario.phases.length}: ${ph.title}`,
        ph.text,
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
        fresh.length ? `The automatic checks found:\n${fresh.map((f) => `- ${f.title}${f.issue ? ` (#${f.issue})` : ''}: ${f.evidence}`).join('\n')}` : '',
      ]
        .filter(Boolean)
        .join('\n\n');
      const answer = await tester.step(prompt, system);
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
        } else if (a.type === 'thread') await d.replyInThread(key, a.text ?? '');
        else if (a.type === 'act') await d.act(key, a);
        else if (a.type === 'review') await d.review(key, { verdict: a.verdict, comments: a.comments ?? [] });
        else if (a.type === 'settings') {
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
        } else if (a.type === 'wait') await sleep(Math.min(300, a.seconds ?? 30) * 1000);
      } catch (e) {
        actionError = e.message;
        log(`action failed: ${e.message}`);
        await d.shotScreen(join(paths.shots, `failed-action-${step}.png`)).catch(() => {});
      }
    }
    await settle();
    await refreshFacts();
    newFindings();
    const all = [...findings.values()];
    await writeReport({ dir, scenario, issues, findings: all, timeline, started, tester, facts, logLines });
    if (opt.file !== 'no') {
      await fileFindings({ dir, scenario, findings: all, timeline, log });
      await writeReport({ dir, scenario, issues, findings: all, timeline, started, tester, facts, logLines });
    }
  } finally {
    await page.close().catch(() => {});
    server.kill();
  }
}

// ── Report ─────────────────────────────────────────────────────────────────────────────────

async function writeReport({ dir, scenario, issues, findings, timeline, started, tester, facts, logLines, rechecked = false }) {
  const title = (n) => issues.find((i) => i.number === n)?.title ?? '(closed, or not in the list)';
  const agentCost = facts.streams.flatMap((s) => s.events.filter((e) => e.type === 'result')).reduce((a, e) => a + (e.total_cost_usd ?? 0), 0);
  // Kiro reports credits, not dollars: they’re listed beside the agents’ cost when a run had Kiro turns.
  const credits = kiroCredits(facts.kiroStreams ?? []);
  const usage = `Usage: agents $${agentCost.toFixed(2)}${credits ? ` and ${credits.toFixed(2)} Kiro credits` : ''}, tester $${tester.spent.toFixed(2)}.`;
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
          `| ${f.severity ?? '—'} | ${f.category ?? '—'} | ${esc(f.component ?? f.check)} | ${esc(f.title)} | ${esc(f.evidence).slice(0, 260)} | ${f.source} (step ${f.step}) | ${f.filed ? `filed #${f.filed}` : f.duplicateOf ? `duplicate of #${f.duplicateOf}` : esc(f.verdict ?? 'not reviewed')}${f.note ? `: ${esc(f.note)}` : ''} |`,
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
  await writeFile(
    join(dir, 'findings.json'),
    `${JSON.stringify({ scenario: scenario.title, started, testerSpent: tester.spent, findings, timeline, probes: facts.probes, samples: facts.samples }, null, 2)}\n`,
  );
  if (rechecked) await writeFile(join(dir, 'run.log'), `${readFileSync(join(dir, 'run.log'), 'utf8')}${logLines.join('\n')}\n`);
  else await writeFile(join(dir, 'run.log'), `${logLines.join('\n')}\n`);
  console.log(
    `\nReport: ${relative(ROOT, join(dir, 'report.md'))} · ${caught.size} known issues caught again · ${findings.filter((f) => !f.issue && f.verdict !== 'harness').length} new findings`,
  );
}

// ── Filing ─────────────────────────────────────────────────────────────────────────────────
// New findings (no open issue matched) are verified in a fresh session, then the confirmed ones are filed
// with the bug template. A hidden fingerprint in each issue keeps a later run from filing the same one.

const PRIORITY = { critical: 'P0', high: 'P1', medium: 'P2', low: 'P3' };
const fingerprint = (f) =>
  `uat:${f.check ?? 'tester'}:${String(f.check ? f.key : f.title)
    .toLowerCase()
    .replace(/\W+/g, '-')
    .slice(0, 60)}`;

async function fileFindings({ dir, scenario, findings, timeline, log }) {
  const gh = (args) => spawnSync('gh', args, { cwd: ROOT, encoding: 'utf8' });
  const open = gh(['issue', 'list', '--state', 'open', '--limit', '300', '--json', 'number,title,body']);
  if (open.status !== 0) return log('Filing skipped: the gh CLI isn’t available or signed in.');
  const issues = JSON.parse(open.stdout);
  const filedBefore = new Map(issues.flatMap((i) => [...(i.body ?? '').matchAll(/<!-- (uat:[^ ]+) -->/g)].map((m) => [m[1], i.number])));
  const pending = findings.filter((f) => !f.issue && !f.filed && !f.verdict);
  for (const f of findings.filter((x) => !x.issue && !x.filed && filedBefore.has(fingerprint(x)))) {
    f.verdict = 'duplicate';
    f.duplicateOf = filedBefore.get(fingerprint(f));
    f.note = `Filed by an earlier run as #${f.duplicateOf}.`;
  }
  const toVerify = pending.filter((f) => !f.verdict);
  if (toVerify.length) {
    log(`Verifying ${toVerify.length} new findings before filing…`);
    try {
      const { value } = await askOnce({
        cwd: dir,
        model: opt['tester-model'],
        prompt: verifyPrompt({ scenario, findings: toVerify, timeline, issues }),
        schema: VERIFY_SCHEMA,
      });
      for (const r of value.results) {
        const f = toVerify[r.index];
        if (!f) continue;
        Object.assign(f, { verdict: r.verdict, note: r.note, ...(r.duplicateOf ? { duplicateOf: r.duplicateOf } : {}) });
        if (r.verdict === 'confirmed') f.filing = r;
      }
    } catch (e) {
      log(`Verification failed, so nothing was filed: ${e.message}`);
      return;
    }
  }
  for (const f of findings.filter((x) => x.verdict === 'confirmed' && x.filing && !x.filed)) {
    const r = f.filing;
    const body = [
      `**Component:** ${r.component}`,
      `**Urgency:** ${r.urgency}`,
      '',
      '## Steps to reproduce',
      '',
      ...r.steps.map((s, i) => `${i + 1}. ${s}`),
      '',
      '## Expected',
      '',
      r.expected,
      '',
      '## What failed instead',
      '',
      r.actual,
      ...(r.cause ? ['', '## Suspected cause', '', r.cause] : []),
      '',
      `Found by the end-to-end UAT ([tests/uat/e2e](https://github.com/HJeon139/postbox/tree/main/tests/uat/e2e)), ${scenario.title}, step ${f.step}. Verified before filing: ${f.note}`,
      '',
      `<!-- ${fingerprint(f)} -->`,
    ].join('\n');
    const labels = ['uat', f.category === 'ux' ? 'ux' : 'bug', PRIORITY[f.severity] ?? 'P2'].join(',');
    const made = gh(['issue', 'create', '--title', r.title, '--body', body, '--label', labels]);
    if (made.status !== 0) {
      log(`Couldn’t file “${r.title}”: ${made.stderr.trim()}`);
      continue;
    }
    f.filed = Number(made.stdout.trim().split('/').pop());
    log(`Filed #${f.filed}: ${r.title}`);
  }
  await writeFile(join(dir, 'findings.json'), `${JSON.stringify({ ...JSON.parse(readFileSync(join(dir, 'findings.json'), 'utf8')), findings }, null, 2)}\n`);
}

// ── Recheck ──────────────────────────────────────────────────────────────────────────────────
// Runs the checks again over a finished run’s saved data (no agents, no tester), for when the checks or the
// driver improved. Tester findings and the timeline are kept; check findings are recomputed.

const LIVE_ONLY = new Set(['fresh-install-agents', 'full-screen-noop', 'image-not-shown', 'silent-while-working']);

async function recheck(dir) {
  dir = resolve(dir);
  const saved = JSON.parse(readFileSync(join(dir, 'findings.json'), 'utf8'));
  const name = dir.replace(/^.*-(\w+)$/, '$1');
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
      console: page.logs,
      apps: {},
      probes: saved.probes ?? { fullScreen: [], attachments: [] },
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
    const live = saved.findings.filter((f) => f.source === 'run' || (f.source === 'check' && LIVE_ONLY.has(f.check)));
    const gh = spawnSync('gh', ['issue', 'list', '--state', 'all', '--limit', '300', '--json', 'number,title'], { cwd: ROOT, encoding: 'utf8' });
    const issues = gh.status === 0 ? JSON.parse(gh.stdout) : [];
    // Verdicts and filed issue numbers from earlier reviews carry over to the recomputed findings.
    const before = new Map(saved.findings.filter((f) => f.source === 'check').map((f) => [`${f.check}:${f.key}`, f]));
    for (const c of checks) {
      const b = before.get(`${c.check}:${c.key}`);
      if (b) for (const k of ['verdict', 'note', 'filed', 'duplicateOf']) if (b[k] !== undefined) c[k] = b[k];
    }
    const findings = [...checks, ...live, ...kept];
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
        rechecked: true,
      });
    await report();
    if (opt.file !== 'no') {
      await fileFindings({ dir, scenario, findings, timeline: saved.timeline, log: (l) => console.log(l) });
      await report();
    }
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
