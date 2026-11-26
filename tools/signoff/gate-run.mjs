// `--run-gate` in tools/signoff.mjs (#845): runs the gate on a clean working tree at HEAD, holding one of the
// machine’s heavy-suite slots (tools/heavy-lock.mjs) or a lock folder given with --lock, and writes the gate log
// (./gate-log.mjs) whatever the commands’ result. The tree and HEAD are checked before the slot is taken, after it
// is, and after the commands: when either changed, the run wasn’t of HEAD’s tree, and no log is written. It runs on the Node CI runs, found by step 2, first on PATH.
//
// Before it takes the slot it checks the temp folder has free inodes: a run that filled them failed tests no change
// touched. It reads the load once, as it takes the slot, since load stays high while any gate runs, and warns above the
// core count rather than failing: the person can’t lower another worktree’s load.

import { dirname, join } from 'node:path';
import { commands, FORMAT, logPath, WRITER } from './gate-log.mjs';
import { untilStopped } from './stop.mjs';
import { exec, loud, must } from './wait.mjs';

/** Free inodes the temp folder needs: Playwright, Chromium and the tests write many small files there. */
export const MIN_FREE_INODES = 100_000;

/**
 * Why the run can’t start, or '': changes in the working tree, a spec file that isn’t there, too few inodes.
 * @param {import('./deps.mjs').Deps} d @param {string} root @param {string[]} specs
 */
async function blocked(d, root, specs) {
  const status = await must(d, ['git', 'status', '--porcelain'], { cwd: root });
  if (status) return `the working tree has changes HEAD doesn’t have: commit or stash them, so the log is for HEAD (${status.split('\n').length} paths)`;
  const missing = specs.filter((s) => !d.exists(join(root, s)));
  if (missing.length) return `no such spec file: ${missing.join(', ')}`;
  const { ffree } = d.statfs(d.tmpdir());
  if (ffree < MIN_FREE_INODES) return `the temp folder ${d.tmpdir()} has ${ffree} free inodes, under ${MIN_FREE_INODES}: free some, then run again`;
  return '';
}

/**
 * What changed in the working tree or HEAD since the gate checked it, or '' when nothing did. The tree is checked clean
 * before the slot is taken, and the wait for a slot and the run itself are long: a log that says clean, for head, is
 * true only when both still hold after each.
 * @param {import('./deps.mjs').Deps} d @param {string} root @param {string} head @param {string} when
 * @param {import('./stop.mjs').Stop} stop
 */
async function changed(d, root, head, when, stop) {
  const status = await must(d, ['git', 'status', '--porcelain'], { cwd: root, stop });
  if (status) return `the working tree changed ${when} (${status.split('\n').length} paths): the log would not be for HEAD, so none is written`;
  const now = await must(d, ['git', 'rev-parse', 'HEAD'], { cwd: root, stop });
  if (now !== head) return `HEAD moved from ${head.slice(0, 8)} to ${now.slice(0, 8)} ${when}: the log would not be for either, so none is written`;
  return '';
}

/**
 * Runs the gate’s commands in order, stopping at the first that fails, and returns each one’s record.
 * @param {import('./deps.mjs').Deps} d @param {string} root @param {string[]} specs @param {string} nodeBin
 * @param {import('./stop.mjs').Stop} stop
 */
async function runCommands(d, root, specs, nodeBin, stop) {
  // POSTBOX_HEAVY_HELD: this run holds the slot, so the suites inside it don’t wait for a second one.
  const base = { PATH: `${dirname(nodeBin)}:${process.env.PATH ?? ''}`, POSTBOX_HEAVY_HELD: '1' };
  /** @type {{ name: string, argv: string[], env: Record<string, string>, code: number, ms: number }[]} */
  const ran = [];
  for (const c of commands(specs)) {
    d.log(`▶ ${c.name}: ${c.argv.join(' ')}`);
    const t0 = d.now();
    const r = await exec(d, c.argv, { cwd: root, env: { ...base, ...c.env }, stream: true, stop });
    ran.push({ ...c, code: r.code, ms: d.now() - t0 });
    if (r.code !== 0) break;
  }
  return ran;
}

/**
 * What runs while the slot is held: the tree and HEAD checked again after the wait, the load reported, the commands,
 * and the tree and HEAD checked once more. Returns the run, or why it can’t be logged.
 * @param {import('./deps.mjs').Deps} d @param {{ root: string, head: string, specs: string[], node: { path: string } }} o
 * @param {import('./stop.mjs').Stop} stop
 */
async function holding(d, { root, head, specs, node }, stop) {
  const waited = await changed(d, root, head, 'while the gate waited for a heavy-suite slot', stop);
  if (waited) return { why: waited };
  const load = { one: d.loadavg()[0], cores: d.cores() };
  d.log(`load ${load.one.toFixed(1)} on ${load.cores} cores as the gate starts`);
  if (load.one > load.cores) d.log(`⚠ the load is above the core count: tests that wait on time may fail for it, not for the change`);
  const startedAt = new Date(d.now()).toISOString();
  const ran = await runCommands(d, root, specs, node.path, stop);
  const during = await changed(d, root, head, 'while the gate ran', stop);
  if (during) return { why: during };
  return { load, startedAt, ran };
}

/**
 * Takes the slot, runs the gate holding it and writes its log. Returns the log written, the load read, or why it
 * couldn’t run or be logged.
 * @param {import('./deps.mjs').Deps} d
 * @param {{ root: string, gitDir: string, head: string, specs: string[], lock?: string, pr: number,
 *   node: { major: number, path: string, version: string } }} o
 */
export async function runGate(d, o) {
  const { root, gitDir, head, specs, lock, pr, node } = o;
  const why = await blocked(d, root, specs);
  if (why) return { why };
  const label = `signoff #${pr} in ${root}`;
  const release = await loud(d, 'a heavy-suite slot', () => d.acquire({ label, log: d.log, ...(lock ? { dir: lock } : {}) }));
  // A signal stops the run and lets the slot go before the script exits (./stop.mjs).
  const r = await untilStopped(d, 'the gate', async (stop) => {
    try {
      return await holding(d, o, stop);
    } finally {
      release();
    }
  });
  if (r.why !== undefined) return { why: r.why };
  const { load, startedAt, ran } = r;
  const log = {
    format: FORMAT,
    writer: WRITER,
    head,
    startedAt,
    endedAt: new Date(d.now()).toISOString(),
    clean: true,
    node: { major: node.major, version: node.version },
    load,
    specs,
    commands: ran,
  };
  d.writeFile(logPath(gitDir, head), `${JSON.stringify(log, null, 2)}\n`);
  return { log, load };
}
