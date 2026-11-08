// The GitHub half of the gate and sign-off script (retro action 3, Draft A2): whether a pull request’s head has every
// check `main` requires, passed, CodeQL included. `gh pr checks` exits 0 with CodeQL missing altogether, so this
// reads the required names from the branch’s live rules instead: each `required_status_checks` context, and each
// `code_scanning` tool, which must have a check run of its own name. A required name with no run fails, as does any
// check run that failed, whether required or not. While any run is still going, a missing name may be a job waiting
// on others, so it counts as not started yet rather than missing. It prints one line per problem and one summary line, and exits 0
// only when everything required has passed.
//
//   node tools/signoff-checks.mjs 783        the pull request’s current head, against its base’s rules

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Exit codes: everything passed; a required check failed or is missing; one is still running; gh itself failed. */
export const EXIT = { pass: 0, fail: 1, pending: 2, error: 3 };

/** Conclusions GitHub counts as passing for a required status check. */
const PASSING = new Set(['success', 'neutral', 'skipped']);
/** Conclusions that make any check red. */
const RED = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale']);

/**
 * What the branch’s rules require: status check contexts, and code-scanning tools whose check run must succeed.
 * @param {{ type: string, parameters?: any }[]} rules the `rules/branches/<base>` response
 */
export function requiredOf(rules) {
  const contexts = rules.filter((r) => r.type === 'required_status_checks').flatMap((r) => r.parameters.required_status_checks.map((c) => c.context));
  const tools = rules.filter((r) => r.type === 'code_scanning').flatMap((r) => r.parameters.code_scanning_tools.map((t) => t.tool));
  return { contexts: [...new Set(contexts)], tools: [...new Set(tools)] };
}

/**
 * Each check run’s newest attempt, by name: a rerun replaces the run before it.
 * @param {{ name: string, status: string, conclusion: string | null, started_at?: string }[]} runs
 */
export function latestByName(runs) {
  /** @type {Map<string, typeof runs[number]>} */
  const latest = new Map();
  for (const run of runs) {
    const seen = latest.get(run.name);
    if (!seen || isNewer(run, seen)) latest.set(run.name, run);
  }
  return latest;
}

/**
 * Whether run is a later attempt than seen. A run still queued or going is the newest: a queued rerun has no
 * started_at yet. Otherwise the later start wins.
 * @param {{ status: string, started_at?: string | null }} run @param {{ status: string, started_at?: string | null }} seen
 */
function isNewer(run, seen) {
  const runOpen = run.status !== 'completed';
  const seenOpen = seen.status !== 'completed';
  if (runOpen !== seenOpen) return runOpen;
  return (run.started_at ?? '') > (seen.started_at ?? '');
}

/** One required name’s state: pass, pending, missing or fail. @param {{ status: string, conclusion: string | null } | undefined} run @param {Set<string>} passing */
function stateOf(run, passing) {
  if (!run) return 'missing';
  if (run.status !== 'completed') return 'pending';
  return passing.has(run.conclusion ?? '') ? 'pass' : 'fail';
}

/**
 * The verdict on a head’s check runs, against what’s required.
 * @param {ReturnType<typeof requiredOf>} required
 * @param {Parameters<typeof latestByName>[0]} runs
 */
export function evaluate(required, runs) {
  const latest = latestByName(runs);
  const rows = [
    ...required.contexts.map((name) => ({ name, kind: 'required', state: stateOf(latest.get(name), PASSING) })),
    ...required.tools.map((name) => ({ name, kind: 'code scanning', state: stateOf(latest.get(name), new Set(['success'])) })),
  ];
  const requiredNames = new Set(rows.map((r) => r.name));
  const red = [...latest.values()].filter((run) => !requiredNames.has(run.name) && RED.has(run.conclusion ?? '')).map((run) => run.name);
  // A job that needs others isn’t created until they end, so a name is missing for good only once nothing runs.
  const running = [...latest.values()].some((run) => run.status !== 'completed');
  for (const row of rows) if (row.state === 'missing' && running) row.state = 'not started';
  // A code-scanning tool’s check run is completed early and updated as each analysis uploads, so while anything still
  // runs, its conclusion either way isn’t final (#903 at 717fc318 read failure, then success).
  for (const row of rows) if (row.kind === 'code scanning' && running) row.state = 'pending';
  const failed = rows.filter((r) => r.state === 'fail' || r.state === 'missing');
  const pending = rows.filter((r) => r.state === 'pending' || r.state === 'not started');
  let exit = EXIT.pass;
  if (pending.length) exit = EXIT.pending;
  if (failed.length || red.length) exit = EXIT.fail;
  return { rows, red, exit };
}

/** The lines to print: one per problem, then the summary. @param {number} pr @param {string} head @param {ReturnType<typeof evaluate>} v */
export function report(pr, head, v) {
  const lines = v.rows.filter((r) => r.state !== 'pass').map((r) => `${r.state}: ${r.name} (${r.kind})`);
  for (const name of v.red) lines.push(`fail: ${name} (not required, but red)`);
  const passed = v.rows.filter((r) => r.state === 'pass').length;
  const scanning = v.rows.filter((r) => r.kind === 'code scanning').map((r) => `${r.name.toLowerCase()}=${r.state}`);
  const verdict = Object.keys(EXIT)
    .find((k) => EXIT[/** @type {keyof EXIT} */ (k)] === v.exit)
    ?.toUpperCase();
  lines.push(`signoff-checks #${pr} head=${head.slice(0, 8)} required=${passed}/${v.rows.length} ${scanning.join(' ')} red=${v.red.length} -> ${verdict}`);
  return lines;
}

/** gh’s JSON output for `args`. @param {string[]} args */
const ghJson = (args) => JSON.parse(execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));

/**
 * Checks pull request `pr`, printing with `log`, and returns the exit code.
 * @param {number} pr @param {{ gh?: (args: string[]) => any, log?: (line: string) => void }} [o]
 */
export function signoffChecks(pr, { gh = ghJson, log = console.log } = {}) {
  let v;
  let head;
  try {
    const repo = gh(['repo', 'view', '--json', 'nameWithOwner']).nameWithOwner;
    const view = gh(['pr', 'view', String(pr), '--json', 'headRefOid,baseRefName']);
    head = view.headRefOid;
    const required = requiredOf(gh(['api', `repos/${repo}/rules/branches/${view.baseRefName}`]));
    // Nothing required means the rules weren't read, not that nothing is required: main always requires checks.
    if (!required.contexts.length && !required.tools.length) {
      log(`signoff-checks #${pr}: no required checks found for ${view.baseRefName}: is its ruleset readable? -> ERROR`);
      return EXIT.error;
    }
    const runs = gh(['api', '--paginate', '--slurp', `repos/${repo}/commits/${head}/check-runs?per_page=100`]).flatMap((page) => page.check_runs);
    v = evaluate(required, runs);
  } catch (e) {
    log(`signoff-checks #${pr}: gh failed: ${/** @type {Error} */ (e).message.split('\n')[0]} -> ERROR`);
    return EXIT.error;
  }
  for (const line of report(pr, head, v)) log(line);
  return v.exit;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pr = Number(process.argv[2]);
  if (!Number.isInteger(pr) || pr <= 0) {
    console.error('Usage: node tools/signoff-checks.mjs <pull request number>');
    process.exit(EXIT.error);
  }
  process.exit(signoffChecks(pr));
}
