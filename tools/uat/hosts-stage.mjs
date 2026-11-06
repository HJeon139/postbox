// An older Postbox staged on a test host before a host-mode run (#464): --stage-host-version <tag> installs that
// tag’s host code on host1 the way that version’s own Postbox installed it, from a temporary worktree of the tag,
// in place of the run’s Install through the UI (tools/uat/hosts-run.mjs, setUpHost). The token it gets goes in the
// run’s Postbox data folder, where the run’s Postbox finds it once it’s there (server/remote/hosts-status.mjs,
// tokenOf), so that Postbox sees an installed host without its own version on it: what someone who updated Postbox
// on their laptop has. The run’s Remove at its end goes through this version’s daemon, which a host with only the
// older version can’t start, so when Remove leaves ~/.postbox-remote there, the end of the run stops that Postbox and
// deletes it itself (tools/uat/hosts-end.mjs, removeStaged); baseline() refused the host if Postbox was there before.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** A tag the option takes: a release’s, v<major>.<minor>.<patch>. */
export const TAG_RE = /^v\d+\.\d+\.\d+$/;

/**
 * A git command in the checkout, as an argument list: its exit status and what it wrote.
 * @param {string[]} args @param {string} cwd @returns {{ code: number, stdout: string, stderr: string }}
 */
export function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 120_000 });
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr || r.error?.message || '' };
}

/**
 * What the option’s check reads of the checkout: this checkout’s package version, and a tag’s, or null when the tag
 * isn’t a commit here or has no package.json with a version.
 * @param {string} root @param {typeof git} [run]
 */
export function tagRepo(root, run = git) {
  return {
    current: () => JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version,
    /** @param {string} tag */
    versionAt: (tag) => {
      if (run(['rev-parse', '--verify', '--quiet', `${tag}^{commit}`], root).code !== 0) return null;
      const r = run(['show', `${tag}:package.json`], root);
      if (r.code !== 0) return null;
      try {
        const v = JSON.parse(r.stdout).version;
        return typeof v === 'string' ? v : null;
      } catch {
        return null;
      }
    },
  };
}

/** A staging worktree’s folder, as mkdtemp names it in a run’s folder. */
const STAGED_RE = /^staged-[A-Za-z0-9]{6}$/;

/**
 * Forgets the staging worktrees a runner killed mid-install left registered (#766): only a staged-XXXXXX folder of a
 * run under `runsRoot`, and only once its folder is gone. `git worktree prune` would forget every worktree of the
 * checkout whose folder is missing, such as one on a drive that isn’t mounted. A list that fails forgets nothing.
 * @param {string} root the checkout @param {string} runsRoot the folder the runs’ folders are in @param {typeof git} [run]
 */
export function forgetStaleStaged(root, runsRoot, run = git) {
  const list = run(['worktree', 'list', '--porcelain', '-z'], root);
  if (list.code !== 0) return;
  const paths = list.stdout
    .split('\0')
    .filter((f) => f.startsWith('worktree '))
    .map((f) => f.slice('worktree '.length));
  for (const path of paths) {
    if (!STAGED_RE.test(basename(path)) || dirname(dirname(path)) !== runsRoot || existsSync(path)) continue;
    run(['worktree', 'remove', '--force', path], root);
  }
}

/**
 * Installs a tag’s host code on a host with that tag’s own server/remote/install.mjs, from a detached worktree of
 * the tag made in the run’s own folder (beside its data folder) and removed after, however the install ended. An
 * error names the host by its label, never its destination.
 * @param {{ root: string, tag: string, version: string, data: string, label: string,
 *   host: { id: string, name: string, settings: Record<string, any> } }} o
 *   root: the checkout; data: the run’s Postbox data folder; host: as the runtime keeps it (its name is the destination)
 * @param {{ run?: typeof git, load?: (file: string) => Promise<any> }} [deps]
 */
export async function stageOlder({ root, tag, version, data, label, host }, { run = git, load = (file) => import(pathToFileURL(file).href) } = {}) {
  const tree = await mkdtemp(join(dirname(data), 'staged-'));
  const bare = host.name.includes('@') ? host.name.slice(host.name.lastIndexOf('@') + 1) : host.name;
  const hide = (/** @type {string} */ s) => String(s).replaceAll(host.name, label).replaceAll(bare, label);
  try {
    forgetStaleStaged(root, dirname(dirname(data)), run);
    const add = run(['worktree', 'add', '--detach', tree, tag], root);
    if (add.code !== 0) throw new Error(`git couldn’t check ${tag} out to stage it on ${label}: ${add.stderr.trim().slice(-300)}`);
    const { installHost } = await load(join(tree, 'server', 'remote', 'install.mjs'));
    return await installHost({ host, version, dataDir: data });
  } catch (e) {
    throw new Error(`Staging Postbox ${version} on ${label} failed: ${hide(e?.message ?? e)}`);
  } finally {
    run(['worktree', 'remove', '--force', tree], root);
    await rm(tree, { recursive: true, force: true });
  }
}
