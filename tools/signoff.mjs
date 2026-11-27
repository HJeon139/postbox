// The local sign-off on a pull request (#845, part A1): what a reviewer runs before saying a head is ready, so a
// sign-off fails loudly where sprint 3’s scripts failed quietly. First it reads the pull request from GitHub and
// fetches its base, once, for the steps that read them. Then four steps, in order, each printed as it ends:
//   1. the head is pushed: the local HEAD is the pull request’s head on GitHub;
//   2. Biome at each commit from the merge base to HEAD (tools/signoff/trees.mjs);
//   3. the merged tree: HEAD merges cleanly with the base freshly fetched from the pull request’s base repository, and
//      the merge passes Biome and the project lints;
//   4. GitHub’s checks: every check main’s rules require, CodeQL included, passed on the head (tools/signoff-checks.mjs,
//      part A2). The full browser passes are CI’s: the required check “Demo in Chrome, with accessibility checks”
//      passes only when every shard of both passed, so this step reads them rather than running them here.
// A failed step doesn’t stop the ones after it, so one run reports every problem. It exits with the first failed
// step’s number, and ends with one summary line to quote in a hand-back. It only reads from GitHub: no label, comment
// or push.
//
//   node tools/signoff.mjs 845

import { fileURLToPath } from 'node:url';
import { parseArgs, USAGE } from './signoff/args.mjs';
import { defaultDeps } from './signoff/deps.mjs';
import { eachCommit, fetchBase, mergedTree } from './signoff/trees.mjs';
import { must } from './signoff/wait.mjs';
import { EXIT as CHECKS_EXIT, signoffChecks } from './signoff-checks.mjs';

/** Exit codes: 0 when every step passed, else the first failed step’s number; 64 for a command line that can’t run. */
export const EXIT = { pass: 0, head: 1, commits: 2, merged: 3, checks: 4, usage: 64 };

/**
 * @typedef {{ ok: boolean, why?: string, note?: string }} StepResult
 * @typedef {{ pr: number, root: string, head: string, load?: { one: number, cores: number }, prError?: string,
 *   prHead?: string, base?: string, prUrl?: string, baseSha?: string, mergeBase?: string, fetchError?: string }} Ctx
 */

/**
 * Before the steps: reads the pull request and fetches its base, so that one decision, in one place, gives steps 2
 * and 3 the same base. A failure is kept for the steps to report: step 1 a pull request gh can’t read, steps 2 and 3
 * a base that couldn’t be fetched.
 * @param {import('./signoff/deps.mjs').Deps} d @param {Ctx} ctx
 */
async function readPullRequest(d, ctx) {
  try {
    const view = d.gh(['pr', 'view', String(ctx.pr), '--json', 'headRefOid,baseRefName,url']);
    Object.assign(ctx, { prHead: view.headRefOid, base: view.baseRefName, prUrl: view.url });
  } catch (e) {
    ctx.prError = e.message.split('\n')[0];
    ctx.fetchError = 'no base branch: step 1 couldn’t read the pull request';
    return;
  }
  try {
    Object.assign(ctx, await fetchBase(d, ctx.root, { pr: ctx.pr, prUrl: String(ctx.prUrl), base: String(ctx.base) }));
  } catch (e) {
    ctx.fetchError = `couldn’t fetch or read the base ${ctx.base}: ${e.message.split('\n')[0]}`;
  }
}

/** Step 1. @param {import('./signoff/deps.mjs').Deps} _d @param {Ctx} ctx @returns {Promise<StepResult>} */
async function headIsPushed(_d, ctx) {
  if (ctx.prError) return { ok: false, why: ctx.prError };
  if (ctx.prHead !== ctx.head) {
    return {
      ok: false,
      why: `local HEAD ${ctx.head.slice(0, 8)} isn’t #${ctx.pr}’s head on GitHub, ${String(ctx.prHead).slice(0, 8)}: push it, or check out that head`,
    };
  }
  return { ok: true, note: `${ctx.head.slice(0, 8)} is #${ctx.pr}’s head, into ${ctx.base}` };
}

/** Step 2. @param {import('./signoff/deps.mjs').Deps} d @param {Ctx} ctx @returns {Promise<StepResult>} */
async function commits(d, ctx) {
  if (!ctx.mergeBase) return { ok: false, why: `no fetched base to compare with: ${ctx.fetchError}` };
  return eachCommit(d, ctx.root, ctx.mergeBase);
}

/** Step 3. @param {import('./signoff/deps.mjs').Deps} d @param {Ctx} ctx @returns {Promise<StepResult>} */
async function merged(d, ctx) {
  if (!ctx.base || !ctx.baseSha) return { ok: false, why: `no fetched base to merge with: ${ctx.fetchError}` };
  return mergedTree(d, ctx.root, ctx.base, ctx.baseSha);
}

/** Step 4: part A2, printing its own lines. @param {import('./signoff/deps.mjs').Deps} d @param {Ctx} ctx @returns {Promise<StepResult>} */
async function checks(d, ctx) {
  const code = signoffChecks(ctx.pr, { gh: d.gh, log: d.log });
  if (code === CHECKS_EXIT.pass) return { ok: true, note: 'every required check passed on GitHub, CodeQL included' };
  const what = Object.keys(CHECKS_EXIT).find((k) => CHECKS_EXIT[/** @type {keyof CHECKS_EXIT} */ (k)] === code);
  return { ok: false, why: `${what}, as the line above says` };
}

const STEPS = /** @type {const} */ ([
  [EXIT.head, 'the head is pushed', headIsPushed],
  [EXIT.commits, 'Biome at each commit', commits],
  [EXIT.merged, 'the merged tree', merged],
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
  d.log(`${r.ok ? '✔' : '✖'} ${n}. ${name}: ${r.ok ? r.note : r.why}`);
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
    const head = await must(d, ['git', 'rev-parse', 'HEAD'], { cwd: root });
    ctx = { ...args, root, head };
  } catch (e) {
    d.log(`✖ 1. the head is pushed: this isn’t a git checkout with a HEAD: ${e.message}`);
    return EXIT.head;
  }
  ctx.load = { one: d.loadavg()[0], cores: d.cores() };
  await readPullRequest(d, ctx);
  /** @type {number[]} */
  const failed = [];
  for (const step of STEPS) {
    const r = await runStep(d, ctx, step);
    if (!r.ok) failed.push(step[0]);
  }
  d.log(summary(ctx, failed));
  return failed[0] ?? EXIT.pass;
}

/** The one line to quote. @param {Ctx} ctx @param {number[]} failed */
function summary(ctx, failed) {
  const passed = STEPS.length - failed.length;
  const load = ctx.load ? `${ctx.load.one.toFixed(1)}/${ctx.load.cores}` : 'unknown';
  const verdict = failed.length ? `FAIL at step ${failed[0]}` : 'PASS';
  return `signoff #${ctx.pr} head=${ctx.head.slice(0, 8)} load=${load} passed=${passed} failed=${failed.length} -> ${verdict}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(await signoff(process.argv.slice(2)));
