// Where UAT runs are kept, and the small record of each one (run.json) that the stats read (tools/uat-stats.mjs).
//
// Runs go to one folder that outlives worktrees: POSTBOX_UAT_RUNS if set, otherwise uat-runs/ in the main checkout.
// The wave 1 and 2 runs were written inside their worktrees and deleted with them, so what they found couldn’t be
// counted again.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { agentsSpent } from './cost.mjs';
import { isTargeted, parseScenario } from './scenario.mjs';

/**
 * The folder runs are written to: POSTBOX_UAT_RUNS, else uat-runs/ beside the main checkout’s .git (found through git’s
 * common dir, which a worktree shares with it), else uat-runs/ in this repo.
 * @param {{ root: string, env?: Record<string, string|undefined>, git?: (args: string[], cwd: string) => string|null }} opts
 */
export function runsRoot({ root, env = process.env, git = gitOut }) {
  if (env.POSTBOX_UAT_RUNS) return resolve(env.POSTBOX_UAT_RUNS);
  const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], root);
  if (common && isAbsolute(common)) return join(dirname(common), 'uat-runs');
  return join(root, 'uat-runs');
}

/** A git command’s output, trimmed, or null if it failed. */
function gitOut(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() || null : null;
}

/** The branch and commit a run is on. @param {string} root @param {typeof gitOut} [git] */
export const gitInfo = (root, git = gitOut) => ({ branch: git(['rev-parse', '--abbrev-ref', 'HEAD'], root), commit: git(['rev-parse', 'HEAD'], root) });

/**
 * Writes JSON atomically: a temporary file beside it, then a rename, so a reader never sees half a file.
 * @param {string} file  @param {unknown} value
 */
export function writeJsonAtomic(file, value) {
  const tmp = join(dirname(file), `.${basename(file)}.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, file);
}

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

/**
 * The model the agents ran on, from their streams’ init events (what Claude Code says it ran), so a refit can tell
 * runs on Haiku from runs on the personas’ own models. Null when no stream says.
 * @param {{ events: any[] }[]} streams
 * @returns {string|null}
 */
export function streamModel(streams) {
  /** @type {Map<string, number>} */
  const n = new Map();
  for (const s of streams ?? []) {
    const m = s.events?.find((e) => e?.type === 'system' && e.subtype === 'init' && typeof e.model === 'string')?.model;
    if (m) n.set(m, (n.get(m) ?? 0) + 1);
  }
  if (!n.size) return null;
  return [...n.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([m]) => m)
    .join('+');
}

/** Each of a run’s Claude Code streams, cut to its init line and its turns’ cost. @param {string} folder */
function streamInits(folder) {
  if (!existsSync(folder)) return [];
  return readdirSync(folder)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => {
      const text = readFileSync(join(folder, f), 'utf8');
      const line = text.split('\n').find((l) => l.includes('"subtype":"init"'));
      let init = null;
      try {
        init = line ? JSON.parse(line) : null;
      } catch {}
      const cost = [...text.matchAll(/"type":"result"[^\n]*?"total_cost_usd":(\d+(?:\.\d+)?)/g)].reduce((a, m) => a + Number(m[1]), 0);
      return { events: init ? [init] : [], cost };
    });
}

/**
 * What a run’s report says about its length and cost: “Run on …, 26 min, 15 steps. Usage: agents $28.59, tester $1.50.”
 * @param {string} md
 */
export function reportFacts(md) {
  const N = String.raw`(\d+(?:\.\d+)?)`;
  const m = new RegExp(String.raw`Run on [^,]*, (?:(\d+) min, )?(\d+) steps[^.]*\. Usage: agents \$${N}(?: and ${N} Kiro credits)?, tester \$${N}`).exec(
    md ?? '',
  );
  // The runner’s “Agents: @critic claude-haiku-5-5, low effort; …” line, read for its first agent.
  const ran = /Agents: @[\w-]+ (its default model|[\w.:+-]+)(?:, (\w+) effort)?/.exec(md ?? '');
  return {
    minutes: m?.[1] ? Number(m[1]) : null,
    steps: m ? Number(m[2]) : null,
    agentsUsd: m ? Number(m[3]) : null,
    kiroCredits: m?.[4] ? Number(m[4]) : null,
    testerUsd: m ? Number(m[5]) : null,
    agentModel: ran && ran[1] !== 'its default model' ? ran[1] : null,
    agentEffort: ran?.[2] ?? null,
  };
}

/**
 * A live run’s record, for run.json: what a refit reads without parsing the report. The agents’ model is what their
 * streams say they ran, or the runner’s --agent-model where there is one; their effort is what they were seeded with
 * (facts.agentEffort: one level, several joined by “/”, or null for the backend’s default), else the runner’s --agent-effort.
 * @param {{ root: string, dir: string, scenario: any, name: string, opt: Record<string, unknown>, started: number, steps: number, cap: number, startPhase?: number,
 *   tester: { spent: number }, facts: any, coverage: any[], now?: number, git?: (args: string[], cwd: string) => string|null }} r
 */
export function runRecord({ root, dir, scenario, name, opt, started, steps, cap, startPhase = 1, tester, facts, coverage, now = Date.now(), git = gitOut }) {
  const agents = agentsSpent(facts.streams ?? []);
  const flag = (k) => (typeof opt[k] === 'string' && opt[k] ? /** @type {string} */ (opt[k]) : null);
  return {
    run: basename(dir),
    scenario: name,
    title: scenario.title,
    kind: isTargeted(scenario) ? 'targeted' : 'exploratory',
    ...gitInfo(root, git),
    agents: { model: streamModel(facts.streams) ?? flag('agent-model'), effort: 'agentEffort' in facts ? facts.agentEffort : flag('agent-effort') },
    testerModel: flag('tester-model'),
    steps,
    stepCap: cap,
    startPhase,
    minutes: Math.round((now - started) / 60000),
    cost: { agents: Math.round(agents * 100) / 100, tester: Math.round((tester.spent ?? 0) * 100) / 100, kiroCredits: null },
    coverage,
  };
}

/** A run folder’s scenario name: from its run.json, else its name after the time (2026-10-23T04-30-34-p0 → p0). */
const scenarioOfDir = (dir) => basename(dir).replace(/^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-/, '');

/**
 * A run’s record: its run.json, filled in from its report, findings and streams where run.json is missing or older,
 * so runs from before run.json are counted too. Null for a folder with no findings.json (a run that didn’t finish).
 * @param {string} dir  @param {{ scenarios?: string }} [opts]  the scenarios folder, to tell targeted runs from exploratory ones
 */
export function readRun(dir, { scenarios } = {}) {
  if (!existsSync(join(dir, 'findings.json'))) return null;
  const findings = readJson(join(dir, 'findings.json'));
  // A findings.json that doesn’t parse isn’t an unfinished run: say so, rather than count it as one.
  if (!findings) throw new Error(`${join(dir, 'findings.json')} doesn’t parse.`);
  const saved = readJson(join(dir, 'run.json')) ?? {};
  const report = existsSync(join(dir, 'report.md')) ? readFileSync(join(dir, 'report.md'), 'utf8') : '';
  const rep = reportFacts(report);
  const name = saved.scenario ?? scenarioOfDir(dir);
  let kind = saved.kind ?? null;
  if (!kind && scenarios && existsSync(join(scenarios, `${name}.md`))) {
    kind = isTargeted(parseScenario(readFileSync(join(scenarios, `${name}.md`), 'utf8'))) ? 'targeted' : 'exploratory';
  }
  const inits = saved.agents?.model ? [] : streamInits(join(dir, 'streams'));
  const agentsUsd = saved.cost?.agents ?? rep.agentsUsd ?? (inits.length ? inits.reduce((a, s) => a + s.cost, 0) : null);
  const testerUsd = saved.cost?.tester ?? rep.testerUsd ?? findings.testerSpent ?? null;
  return {
    dir,
    run: basename(dir),
    scenario: name,
    kind: kind ?? 'exploratory',
    branch: saved.branch ?? null,
    commit: saved.commit ?? null,
    agents: {
      model: saved.agents?.model ?? rep.agentModel ?? streamModel(inits) ?? null,
      effort: saved.agents?.effort ?? rep.agentEffort ?? null,
    },
    testerModel: saved.testerModel ?? null,
    steps: saved.steps ?? rep.steps ?? (Array.isArray(findings.timeline) ? findings.timeline.length : 0),
    minutes: saved.minutes ?? rep.minutes ?? null,
    cost: { agents: agentsUsd, tester: testerUsd, kiroCredits: saved.cost?.kiroCredits ?? rep.kiroCredits ?? null },
    coverage: saved.coverage ?? findings.coverage ?? null,
    findings: Array.isArray(findings.findings) ? findings.findings : [],
    // Telemetry (designs/telemetry-persona.md, U5): the run’s block, and the classifier’s proposals, never filed.
    telemetry: saved.telemetry ?? null,
    // The run’s budget (tools/uat/budget.mjs), when it had --max-cost.
    budget: saved.budget ?? null,
    proposals: Array.isArray(findings.telemetry?.proposals) ? findings.telemetry.proposals : [],
  };
}

/**
 * Every finished run under these folders, oldest first, once each: a run copied to two places counts once.
 * @param {string[]} roots  @param {{ scenarios?: string }} [opts]
 */
export function readRuns(roots, opts = {}) {
  /** @type {Map<string, any>} */
  const out = new Map();
  /** @type {Set<string>} */
  const unfinished = new Set();
  /** @type {string[]} */
  const unreadable = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    // A Postbox folder’s telemetry/ holds each conversation’s saved reports, each a live run (R20).
    const live = (name) => (existsSync(join(root, name, 'reports')) ? readdirSync(join(root, name, 'reports')).map((id) => join(name, 'reports', id)) : [name]);
    for (const name of readdirSync(root).sort().flatMap(live)) {
      const dir = join(root, name);
      if (!statSync(dir).isDirectory() || out.has(name)) continue;
      let r = null;
      try {
        r = readRun(dir, opts);
      } catch (e) {
        unreadable.push(e.message);
        continue;
      }
      if (r) {
        out.set(name, r);
        unfinished.delete(name);
      } else unfinished.add(name);
    }
  }
  return { runs: [...out.values()].sort((a, b) => a.run.localeCompare(b.run)), unfinished: unfinished.size, unreadable };
}
