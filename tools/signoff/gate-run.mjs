// `--run-gate` in tools/signoff.mjs (#845): runs the gate on a clean working tree at HEAD, holding one of the
// machine’s heavy-suite slots (tools/heavy-lock.mjs) or a lock folder given with --lock, and writes the gate log
// (./gate-log.mjs) whatever the result. It runs on the Node CI runs, found by step 2, first on PATH.
//
// Before it takes the slot it checks the temp folder has free inodes: a run that filled them failed tests no change
// touched. It reads the load once, as it takes the slot, since load stays high while any gate runs, and warns above the
// core count rather than failing: the person can’t lower another worktree’s load.

import { dirname, join } from 'node:path';
import { commands, FORMAT, logPath, WRITER } from './gate-log.mjs';
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
 * Runs the gate’s commands in order, stopping at the first that fails, and returns each one’s record.
 * @param {import('./deps.mjs').Deps} d @param {string} root @param {string[]} specs @param {string} nodeBin
 */
async function runCommands(d, root, specs, nodeBin) {
  // POSTBOX_HEAVY_HELD: this run holds the slot, so the suites inside it don’t wait for a second one.
  const base = { PATH: `${dirname(nodeBin)}:${process.env.PATH ?? ''}`, POSTBOX_HEAVY_HELD: '1' };
  /** @type {{ name: string, argv: string[], env: Record<string, string>, code: number, ms: number }[]} */
  const ran = [];
  for (const c of commands(specs)) {
    d.log(`▶ ${c.name}: ${c.argv.join(' ')}`);
    const t0 = d.now();
    const r = await exec(d, c.argv, { cwd: root, env: { ...base, ...c.env }, stream: true });
    ran.push({ ...c, code: r.code, ms: d.now() - t0 });
    if (r.code !== 0) break;
  }
  return ran;
}

/**
 * Takes the slot, reports the load, runs the gate and writes its log. Returns the log written, the load read, or why
 * it couldn’t run.
 * @param {import('./deps.mjs').Deps} d
 * @param {{ root: string, gitDir: string, head: string, specs: string[], lock?: string, pr: number,
 *   node: { major: number, path: string, version: string } }} o
 */
export async function runGate(d, { root, gitDir, head, specs, lock, pr, node }) {
  const why = await blocked(d, root, specs);
  if (why) return { why };
  const label = `signoff #${pr} in ${root}`;
  const release = await loud(d, 'a heavy-suite slot', () => d.acquire({ label, log: d.log, ...(lock ? { dir: lock } : {}) }));
  const load = { one: d.loadavg()[0], cores: d.cores() };
  d.log(`load ${load.one.toFixed(1)} on ${load.cores} cores as the gate starts`);
  if (load.one > load.cores) d.log(`⚠ the load is above the core count: tests that wait on time may fail for it, not for the change`);
  const startedAt = new Date(d.now()).toISOString();
  let ran;
  try {
    ran = await runCommands(d, root, specs, node.path);
  } finally {
    release();
  }
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
