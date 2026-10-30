// The runner's --recheck (tools/uat-run.mjs), moved here whole from it.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { launch, sleep } from '../browser.mjs';
import { runChecks } from './checks.mjs';
import { driver } from './driver.mjs';
import { readHistory } from './history.mjs';
import { readHosts } from './hosts-run.mjs';
import { forHosts } from './hosts-scenario.mjs';
import { recordedPhases, selectPhases } from './phases.mjs';
import { portFree } from './postbox.mjs';
import { newProbes } from './probes.mjs';
import { presetFindings } from './regressions.mjs';
import { writeReport } from './report.mjs';
import { reviewFindings } from './review.mjs';
import { readStreams, transcriptsFor, userSetup } from './run-files.mjs';
import { readRun, runsRoot, writeJsonAtomic } from './runs.mjs';
import { isTargeted, parseScenario, phaseCap } from './scenario.mjs';
import { gapFinding, phaseGoals } from './triggers.mjs';
import { withoutPreset } from './verdicts.mjs';

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

/**
 * What a recheck’s checks read from a finished run’s folder: the conversation’s threads, the streams, the history, and
 * the probes, samples and budget the run saved. What the page shows (its apps and UI) is read after.
 * @param {string} dir  @param {{ state: any, mainId: string, saved: any, logs: any[], hostsRec: any }} o
 */
export function savedFacts(dir, { state, mainId, saved, logs, hostsRec }) {
  return {
    state,
    threads: [
      mainId,
      ...Object.values(state.threads)
        .filter((t) => t.parentId === mainId)
        .map((t) => t.id),
    ],
    startPersonas: [],
    streams: readStreams(join(dir, 'streams')),
    kiroStreams: readStreams(join(dir, 'streams', 'kiro')),
    agyStreams: readStreams(join(dir, 'streams', 'agy')),
    codexStreams: readStreams(join(dir, 'streams', 'codex')),
    events: readHistory(dir),
    console: logs,
    apps: {},
    probes: { ...newProbes(), ...(saved.probes ?? {}) },
    samples: saved.samples ?? [],
    budget: saved.budget ?? null,
    ui: {},
    ...userSetup(join(dir, 'workspace')),
    ...(hostsRec ? { hosts: hostsRec } : {}),
  };
}

/**
 * Rechecks a finished run. root: Postbox's checkout; opt: the runner's options; review: what verifying and filing
 * need (tools/uat/review.mjs).
 * @param {string} dir  @param {{ root: string, opt: Record<string, any>, review: Record<string, any> }} o
 */
export async function recheck(dir, { root, opt, review }) {
  // A run folder, or a run’s name in the runs folder.
  dir = existsSync(dir) ? resolve(dir) : join(runsRoot({ root: root }), dir);
  const saved = JSON.parse(readFileSync(join(dir, 'findings.json'), 'utf8'));
  // Its record before the report is rewritten: the minutes it took are only in the first report.
  const record = readRun(dir);
  const name = existsSync(join(dir, 'run.json')) && record?.scenario ? record.scenario : dir.replace(/^.*-([\w-]+)$/, '$1');
  // A host-mode run’s hosts (#120), with what its checks read, and a --phases run’s phases: its phases as played.
  const hostsRec = readHosts(dir);
  const parsed = selectPhases(parseScenario(readFileSync(join(root, 'tests', 'uat', 'e2e', 'scenarios', `${name}.md`), 'utf8')), recordedPhases(record));
  const scenario = hostsRec ? forHosts(parsed, hostsRec.placement, hostsRec.hosts) : parsed;
  const port = Number(opt.port);
  if (!(await portFree(port))) throw new Error(`Port ${port} is in use. Pick another with --port.`);
  const server = spawn(process.execPath, [join(root, 'server', 'index.mjs'), '--port', String(port), '--data', join(dir, 'data')], {
    cwd: root,
    env: { ...process.env, POSTBOX_BACKENDS: 'mock' },
    stdio: 'ignore',
  });
  const origin = `http://127.0.0.1:${port}`;
  const page = await launch();
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
    const facts = savedFacts(dir, { state, mainId: main.id, saved, logs: page.logs, hostsRec });
    facts.transcripts = transcriptsFor(dir, facts);
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
    const gh = spawnSync('gh', ['issue', 'list', '--state', 'all', '--limit', '300', '--json', 'number,title'], { cwd: root, encoding: 'utf8' });
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
    presetFindings(findings, { root: root, commit: record?.commit ?? null });
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
        ...review,
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
