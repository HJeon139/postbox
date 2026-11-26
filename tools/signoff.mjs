// The local sign-off on a pull request (#845, part A1): what a reviewer runs before saying a head is ready, so a
// sign-off fails loudly where sprint 3’s scripts failed quietly. Six steps, in order, each printed as it ends:
//   1. the head is pushed: the local HEAD is the pull request’s head on GitHub;
//   2. the toolchain: every Node major CI runs is installed (tools/signoff/toolchain.mjs);
//   3. Biome at each commit from the merge base to HEAD (tools/signoff/trees.mjs);
//   4. the merged tree: HEAD merges cleanly with a freshly fetched base, and the merge passes Biome and the project lints;
//   5. the gate: a log this script wrote for this exact head shows npm run check and both full browser runs passed
//      (tools/signoff/gate-log.mjs), or with --run-gate, it runs them now and writes that log (tools/signoff/gate-run.mjs);
//   6. GitHub’s checks: every check main’s rules require, CodeQL included, passed on the head (tools/signoff-checks.mjs,
//      part A2).
// A failed step doesn’t stop the ones after it, so one run reports every problem; only --run-gate’s long run waits for
// the steps before it to pass. It exits with the first failed step’s number, and ends with one summary line to quote in
// a hand-back. It only reads from GitHub: no label, comment or push.
//
//   node tools/signoff.mjs 845                read the gate log for this head
//   node tools/signoff.mjs 845 --run-gate     run the gate now, then sign off

import { fileURLToPath } from 'node:url';
import { parseArgs, USAGE } from './signoff/args.mjs';
import { defaultDeps } from './signoff/deps.mjs';
import { readLog, verdict } from './signoff/gate-log.mjs';
import { runGate } from './signoff/gate-run.mjs';
import { ciMajors, toolchain } from './signoff/toolchain.mjs';
import { eachCommit, fetchBase, mergedTree } from './signoff/trees.mjs';
import { must } from './signoff/wait.mjs';
import { EXIT as CHECKS_EXIT, signoffChecks } from './signoff-checks.mjs';

/** Exit codes: 0 when every step passed, else the first failed step’s number; 64 for a command line that can’t run. */
export const EXIT = { pass: 0, head: 1, toolchain: 2, commits: 3, merged: 4, gate: 5, checks: 6, usage: 64 };

/**
 * @typedef {{ ok: boolean, why?: string, note?: string, skip?: string }} StepResult
 * @typedef {{ pr: number, runGate: boolean, specs: string[], nodes: string[], lock?: string, root: string,
 *   gitDir: string, head: string, failed: boolean, load?: { one: number, cores: number }, base?: string,
 *   baseSha?: string, mergeBase?: string, fetchError?: string, node?: { major: number, path: string, version: string } }} Ctx
 */

/** Step 1. @param {import('./signoff/deps.mjs').Deps} d @param {Ctx} ctx @returns {Promise<StepResult>} */
async function headIsPushed(d, ctx) {
  const view = d.gh(['pr', 'view', String(ctx.pr), '--json', 'headRefOid,baseRefName']);
  ctx.base = view.baseRefName;
  if (view.headRefOid !== ctx.head) {
    return {
      ok: false,
      why: `local HEAD ${ctx.head.slice(0, 8)} isn’t #${ctx.pr}’s head on GitHub, ${String(view.headRefOid).slice(0, 8)}: push it, or check out that head`,
    };
  }
  return { ok: true, note: `${ctx.head.slice(0, 8)} is #${ctx.pr}’s head, into ${ctx.base}` };
}

/** Step 2. @param {import('./signoff/deps.mjs').Deps} d @param {Ctx} ctx @returns {Promise<StepResult>} */
async function nodes(d, ctx) {
  const r = await toolchain(d, ctx.root, ctx.nodes);
  // The gate runs on the newest major CI runs.
  const found = Object.entries(r.found ?? {}).sort((a, b) => Number(b[0]) - Number(a[0]))[0];
  if (r.ok && found) ctx.node = { major: Number(found[0]), ...found[1] };
  return r;
}

/** Step 3: fetches the base first, for this step and the next. @param {import('./signoff/deps.mjs').Deps} d @param {Ctx} ctx @returns {Promise<StepResult>} */
async function commits(d, ctx) {
  if (!ctx.base) return { ok: false, why: 'no base branch: step 1 couldn’t read the pull request' };
  try {
    Object.assign(ctx, await fetchBase(d, ctx.root, ctx.base));
  } catch (e) {
    ctx.fetchError = e.message;
    return { ok: false, why: `couldn’t fetch ${ctx.base}: ${e.message}` };
  }
  return eachCommit(d, ctx.root, /** @type {string} */ (ctx.mergeBase));
}

/** Step 4. @param {import('./signoff/deps.mjs').Deps} d @param {Ctx} ctx @returns {Promise<StepResult>} */
async function merged(d, ctx) {
  if (!ctx.base || !ctx.baseSha) return { ok: false, why: `no fetched base to merge with: ${ctx.fetchError ?? 'step 1 couldn’t read the pull request'}` };
  return mergedTree(d, ctx.root, ctx.base, ctx.baseSha);
}

/** Step 5. @param {import('./signoff/deps.mjs').Deps} d @param {Ctx} ctx @returns {Promise<StepResult>} */
async function gate(d, ctx) {
  const majors = ciMajors(d, ctx.root).map((m) => m.major);
  let log;
  if (ctx.runGate) {
    if (ctx.failed) return { ok: false, skip: 'an earlier step failed: fix it before the gate’s long run' };
    if (!ctx.node) return { ok: false, why: 'no Node that CI runs to run the gate on (step 2)' };
    const r = await runGate(d, { ...ctx, node: ctx.node });
    if (r.why) return { ok: false, why: r.why };
    ctx.load = r.load;
    log = r.log;
  } else {
    const r = readLog(d, ctx.gitDir, ctx.head);
    if (r.why) return { ok: false, why: r.why };
    log = r.log;
  }
  const why = verdict(log, ctx.head, majors);
  if (why) return { ok: false, why };
  return { ok: true, note: `npm run check and both browser runs passed on ${log.node.version}, ended ${log.endedAt}` };
}

/** Step 6: part A2, printing its own lines. @param {import('./signoff/deps.mjs').Deps} d @param {Ctx} ctx @returns {Promise<StepResult>} */
async function checks(d, ctx) {
  const code = signoffChecks(ctx.pr, { gh: d.gh, log: d.log });
  if (code === CHECKS_EXIT.pass) return { ok: true, note: 'every required check passed on GitHub, CodeQL included' };
  const what = Object.keys(CHECKS_EXIT).find((k) => CHECKS_EXIT[/** @type {keyof CHECKS_EXIT} */ (k)] === code);
  return { ok: false, why: `GitHub’s checks: ${what}, as the line above says` };
}

const STEPS = /** @type {const} */ ([
  [EXIT.head, 'the head is pushed', headIsPushed],
  [EXIT.toolchain, 'the toolchain', nodes],
  [EXIT.commits, 'Biome at each commit', commits],
  [EXIT.merged, 'the merged tree', merged],
  [EXIT.gate, 'the gate', gate],
  [EXIT.checks, 'GitHub’s checks', checks],
]);

/**
 * Runs one step, turning a throw into its failure, and prints its line.
 * @param {import('./signoff/deps.mjs').Deps} d @param {Ctx} ctx @param {(typeof STEPS)[number]} step
 */
async function runStep(d, ctx, [n, name, fn]) {
  /** @type {StepResult} */
  let r;
  try {
    r = await fn(d, ctx);
  } catch (e) {
    r = { ok: false, why: e.message.split('\n')[0] };
  }
  if (r.skip) d.log(`– ${n}. ${name}: skipped, ${r.skip}`);
  else d.log(`${r.ok ? '✔' : '✖'} ${n}. ${name}: ${r.ok ? r.note : r.why}`);
  if (!r.ok && !r.skip) ctx.failed = true;
  return r;
}

/**
 * Signs off pull request argv[0] and returns the exit code.
 * @param {string[]} argv @param {import('./signoff/deps.mjs').Deps} [d]
 */
export async function signoff(argv, d = defaultDeps()) {
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    d.log(`${args.error}\n${USAGE}`);
    return EXIT.usage;
  }
  /** @type {Ctx} */
  let ctx;
  try {
    const root = await must(d, ['git', 'rev-parse', '--show-toplevel']);
    const gitDir = await must(d, ['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root });
    const head = await must(d, ['git', 'rev-parse', 'HEAD'], { cwd: root });
    ctx = { ...args, root, gitDir, head, failed: false };
  } catch (e) {
    d.log(`✖ 1. the head is pushed: this isn’t a git checkout with a HEAD: ${e.message}`);
    return EXIT.head;
  }
  ctx.load = { one: d.loadavg()[0], cores: d.cores() };
  /** @type {number[]} */
  const failed = [];
  let skipped = 0;
  for (const step of STEPS) {
    const r = await runStep(d, ctx, step);
    if (r.skip) skipped++;
    else if (!r.ok) failed.push(step[0]);
  }
  d.log(summary(ctx, failed, skipped));
  return failed[0] ?? EXIT.pass;
}

/** The one line to quote. @param {Ctx} ctx @param {number[]} failed @param {number} skipped */
function summary(ctx, failed, skipped) {
  const passed = STEPS.length - failed.length - skipped;
  const load = ctx.load ? `${ctx.load.one.toFixed(1)}/${ctx.load.cores}` : 'unknown';
  const verdict = failed.length ? `FAIL at step ${failed[0]}` : 'PASS';
  return `signoff #${ctx.pr} head=${ctx.head.slice(0, 8)} load=${load} passed=${passed} failed=${failed.length} skipped=${skipped} -> ${verdict}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(await signoff(process.argv.slice(2)));
