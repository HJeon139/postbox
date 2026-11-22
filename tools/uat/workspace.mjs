// The run’s project folder (the workspace): where it lives, outside the checkout (runPaths, #885), made before Postbox
// starts as a git repository of its own with what the scenario’s `- seed:` plants in it (tools/uat/scenario.mjs), and
// kept in the run’s folder once the run has stopped (retainWorkspace).

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { seedFakeEnv } from './allowonce-triggers.mjs';
import { seedFiles } from './fixtures.mjs';
import { seedGitRemote } from './git-remote.mjs';
import { hideSteeringAbove } from './steering.mjs';

/**
 * Makes the workspace a repository and seeds it.
 * @param {{ seed: string|null, files?: string|null }} scenario  @param {{ workspace: string }} paths  @param {string} dir  the run’s folder
 */
export function makeWorkspace(scenario, paths, dir) {
  // The workspace is a git repository of its own, so an agent’s git add and commit land there, and git never looks
  // above it for one. It once lay inside the Postbox checkout, where they landed in Postbox’s history; it’s in a temp
  // folder of its own now (runPaths, #885).
  spawnSync('git', ['init', '-q', paths.workspace], { stdio: 'ignore' });
  if (scenario.seed === 'fake-env') seedFakeEnv(paths.workspace);
  if (scenario.seed === 'git-remote') seedGitRemote(paths.workspace, dir);
  if (scenario.files) seedFiles(paths.workspace, scenario.files);
  // After the seeds, so the excludes join any settings one planted. The run’s folder is the tester’s.
  hideSteeringAbove(paths.workspace);
  hideSteeringAbove(dir);
}

/**
 * The run’s folders, made: Postbox’s data, the workspace, each backend’s recorded streams, and screenshots. The
 * workspace is outside the Postbox checkout, in a temp folder of its own, so an agent that reads above it reaches none
 * of the checkout’s files, such as the visual skill’s briefs and their answers (#885); retainWorkspace keeps it in the
 * run’s folder, as workspace/, once the run has stopped. A temp folder inside the checkout, by TMPDIR, is refused: the
 * workspace would be under the checkout again. The run’s own folders come first, so a run that can’t make them leaves no
 * temp folder; one that fails after it removes it.
 * @param {string} dir
 * @param {{ root: string, main?: string, tmp?: string }} o  the checkout, its main clone when it’s a worktree, and where the
 *   workspace’s folder goes (the system temp folder)
 */
export async function runPaths(dir, { root, main = root, tmp = tmpdir() }) {
  const base = await realpath(tmp);
  // The checkout the run is from, and the main clone a worktree shares (runs.mjs, mainCheckout).
  for (const folder of new Set([root, main])) {
    const checkout = await realpath(folder).catch(() => folder);
    if (base === checkout || base.startsWith(checkout + sep))
      throw new Error(
        `The temp folder ${base} is inside the Postbox checkout, so a run’s agents could read the checkout from their workspace (#885). Set TMPDIR to a folder outside ${checkout}, and run again.`,
      );
  }
  const paths = {
    data: join(dir, 'data'),
    streams: join(dir, 'streams'),
    kiroStreams: join(dir, 'streams', 'kiro'),
    agyStreams: join(dir, 'streams', 'agy'),
    codexStreams: join(dir, 'streams', 'codex'),
    sdkStreams: join(dir, 'streams', 'sdk'),
    shots: join(dir, 'shots'),
  };
  for (const p of Object.values(paths)) await mkdir(p, { recursive: true });
  const outside = await mkdtemp(join(base, 'postbox-uat-workspace-'));
  const workspace = join(outside, 'workspace');
  try {
    await mkdir(workspace);
    // Where the agents work, in the run’s folder from the start, so a recheck of a run that ended before its run.json
    // (Ctrl-C, an error) reads their commands against it (workspaceOf).
    writeFileSync(join(dir, WORKSPACE_PATH), `${workspace}\n`);
  } catch (e) {
    rmSync(outside, { recursive: true, force: true });
    throw e;
  }
  return { ...paths, workspace, kept: join(dir, 'workspace'), outside };
}

/** The file in the run’s folder that names where its agents worked. */
const WORKSPACE_PATH = 'workspace-path';

/**
 * Where a run’s agents worked, as its checks read their commands: run.json’s record, else the file runPaths wrote
 * when it made the workspace, else workspace/ in the run’s folder, as for a run from before #885.
 * @param {string} dir  the run’s folder @param {{ workspace?: string } | null | undefined} record  its run.json
 */
export function workspaceOf(dir, record) {
  if (record?.workspace) return record.workspace;
  const file = join(dir, WORKSPACE_PATH);
  const named = existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
  return named || join(dir, 'workspace');
}

/**
 * Keeps the workspace in the run’s folder when the process exits, whatever ends the run, after its stop (#885).
 * @param {{ workspace: string, kept: string, outside: string }} paths @param {{ once: (event: 'exit', fn: () => void) => unknown }} [on]
 */
export function keepOnExit(paths, on = process) {
  on.once('exit', () => retainWorkspace(paths));
}

/**
 * Copies the workspace into the run’s folder as workspace/, where a person and --recheck read it, and removes its temp
 * folder (#885). Once, however often it’s called: the run’s stop calls it once Postbox has stopped, and the process’s
 * exit again, for a run that ends before it has a stop (an error in setup) or exits mid-stop (a second Ctrl-C). It
 * never throws, so a folder it can’t copy or remove, such as a read-only one an agent left, doesn’t fail the run’s exit
 * or skip what else runs then: it says what’s left, and where.
 * @param {{ workspace: string, kept: string, outside: string }} paths @param {(line: string) => void} [log]
 */
export function retainWorkspace(paths, log = (line) => console.error(line)) {
  if (!existsSync(paths.outside)) return;
  try {
    if (existsSync(paths.workspace)) cpSync(paths.workspace, paths.kept, { recursive: true, verbatimSymlinks: true, force: true });
    rmSync(paths.outside, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch (e) {
    log(`Couldn’t keep the workspace in the run’s folder, or remove ${paths.outside}: ${/** @type {Error} */ (e).message}`);
  }
}
