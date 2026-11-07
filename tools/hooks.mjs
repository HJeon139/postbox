// npm run hooks (#508, #787): points git at the hooks in .githooks/ by setting core.hooksPath in the clone’s config,
// which its worktrees share, and says so. It first names what git stops running: another core.hooksPath it replaces,
// or a hook of the person’s own in the clone’s hooks folder (git’s .sample files aren’t hooks). It runs git in the
// folder it’s run from, and reads the old setting before it writes the new one, since git’s hooks path follows it.

import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const HOOKS = '.githooks';
const MOVE = `move what you still need into ${HOOKS}.`;

/** Git’s output, trimmed, or '' when git fails (an unset key exits 1). @param {string[]} args */
function git(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

/** The hooks of the person’s own in a hooks folder, by name, or none when it doesn’t exist. @param {string} dir */
function ownHooks(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => !entry.isDirectory() && !entry.name.endsWith('.sample'))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

const old = git(['config', '--get', 'core.hooksPath']);
if (old && old !== HOOKS) {
  console.log(`hooks: core.hooksPath was ${old}, so git no longer runs the hooks there; ${MOVE}`);
} else if (!old) {
  const dir = resolve(git(['rev-parse', '--git-common-dir']), 'hooks');
  const own = ownHooks(dir);
  if (own.length) console.log(`hooks: git no longer runs ${own.join(', ')} in ${dir}; ${MOVE}`);
}
execFileSync('git', ['config', 'core.hooksPath', HOOKS], { stdio: 'inherit' });
console.log(`hooks: git now runs the hooks in ${HOOKS}: commit-msg checks each message, and pre-commit runs npm run lint:project.`);
