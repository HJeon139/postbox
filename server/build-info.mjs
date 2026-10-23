// The build the server is running: its version from package.json, and the commit it was built from. The commit comes
// from POSTBOX_COMMIT when a package was built with it, else from the git checkout Postbox runs in, else it’s unknown.
// The sidebar shows both under Personas, so a bug report or a screenshot says which build it came from.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * @param {{ root: string, env?: NodeJS.ProcessEnv, git?: (args: string[]) => string }} opts  git is injected by tests
 * @returns {{ version: string, commit: string|null }}
 */
export function buildInfo({
  root,
  env = process.env,
  git = (args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }),
}) {
  let version = '0.0.0';
  try {
    version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version ?? version;
  } catch {}
  let commit = /^[0-9a-f]{7,40}$/i.test(env.POSTBOX_COMMIT ?? '') ? String(env.POSTBOX_COMMIT).slice(0, 7).toLowerCase() : null;
  if (!commit) {
    try {
      commit = git(['rev-parse', '--short=7', 'HEAD']).trim() || null;
    } catch {
      commit = null;
    }
  }
  return { version, commit };
}
