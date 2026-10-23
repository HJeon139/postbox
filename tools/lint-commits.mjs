// Checks that commit messages follow Conventional Commits (tools/commits.mjs), so each release can be versioned from
// them (tools/release.mjs). CI runs it on a pull request’s commits; .githooks/commit-msg runs it as you commit.
//
//   node tools/lint-commits.mjs                      the commits on this branch that main doesn’t have
//   node tools/lint-commits.mjs origin/main..HEAD    a range
//   node tools/lint-commits.mjs RANGE --since DATE   only commits made after DATE
//   node tools/lint-commits.mjs --message-file F     one message (the commit-msg hook)

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseCommit } from './commits.mjs';

const args = process.argv.slice(2);
/** @type {{ id: string, message: string }[]} */
let commits;
if (args[0] === '--message-file') {
  // A message being written has comment lines git removes later.
  const message = readFileSync(args[1], 'utf8')
    .split('\n')
    .filter((l) => !l.startsWith('#'))
    .join('\n')
    .trim();
  commits = [{ id: 'this commit', message }];
} else {
  // --since DATE skips older commits: branches started before the rule keep their plain messages.
  const at = args.indexOf('--since');
  const since = at >= 0 ? ['--since', args[at + 1]] : [];
  const range = args.find((a, i) => !a.startsWith('--') && (at < 0 || i !== at + 1)) ?? 'origin/main..HEAD';
  const out = execFileSync('git', ['log', '--no-merges', ...since, '--format=%h%x00%B%x1e', range], { encoding: 'utf8' });
  commits = out
    .split('\x1e')
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [id, message] = r.split('\0');
      return { id, message: message.trim() };
    });
}
const bad = commits.map((c) => ({ ...c, r: parseCommit(c.message) })).filter((c) => !c.r.ok);
for (const c of bad) console.error(`✖ ${c.id}: ${c.r.ok ? '' : c.r.error}`);
if (bad.length) {
  console.error(
    `\n${bad.length} of ${commits.length} commit messages don’t follow Conventional Commits. See designs/engineering-practices.md, “Commits and versions”.`,
  );
  process.exit(1);
}
console.log(`lint-commits: ${commits.length === 1 ? 'the commit message follows' : `${commits.length} commit messages follow`} Conventional Commits.`);
