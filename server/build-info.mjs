// The build the server is running: its version from package.json, and the commit it was built from. The commit comes
// from POSTBOX_COMMIT when a package was built with it, else from the git checkout Postbox runs in, else from
// server/build-commit.txt, which `npm pack` writes into the package (#157), else it’s unknown. Git counts only when
// Postbox’s folder is the top of the checkout: an installed copy can sit inside someone else’s repository, whose
// commit isn’t Postbox’s. The sidebar shows both under Personas, so a bug report or a screenshot says which build it
// came from.
//
//   node server/build-info.mjs pack     writes server/build-commit.txt (npm’s prepack)
//   node server/build-info.mjs unpack   removes it again (postpack), so a clone never shows a stale one

import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const COMMIT = /^[0-9a-f]{7,40}$/i;
const commitFile = (root) => join(root, 'server', 'build-commit.txt');

/** @typedef {(args: string[]) => string} Git */
/** @param {string} root @returns {Git} */
const realGit = (root) => (args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

/**
 * The commit of the git checkout whose top is root, or null.
 * @param {string} root @param {Git} git
 */
function gitCommit(root, git) {
  try {
    const [top, sha] = git(['rev-parse', '--show-toplevel', '--short=7', 'HEAD']).trim().split('\n');
    return realpathSync(top) === realpathSync(root) && COMMIT.test(sha ?? '') ? sha : null;
  } catch {
    return null;
  }
}

/**
 * @param {{ root: string, env?: NodeJS.ProcessEnv, git?: Git }} opts  git is injected by tests
 * @returns {{ version: string, commit: string|null }}
 */
export function buildInfo({ root, env = process.env, git = realGit(root) }) {
  let version = '0.0.0';
  try {
    version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version ?? version;
  } catch {}
  let commit = COMMIT.test(env.POSTBOX_COMMIT ?? '') ? String(env.POSTBOX_COMMIT).slice(0, 7).toLowerCase() : gitCommit(root, git);
  if (!commit) {
    try {
      const packed = readFileSync(commitFile(root), 'utf8').trim();
      commit = COMMIT.test(packed) ? packed.slice(0, 7).toLowerCase() : null;
    } catch {
      commit = null;
    }
  }
  return { version, commit };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  if (process.argv[2] === 'pack') {
    // Packed from somewhere that isn’t a git checkout, the package has no commit, and the sidebar shows the version alone.
    const sha = gitCommit(root, realGit(root));
    if (sha) writeFileSync(commitFile(root), `${sha}\n`);
  } else if (process.argv[2] === 'unpack') rmSync(commitFile(root), { force: true });
}
