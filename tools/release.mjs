// Releases a version: from the commits since the last tag, the next semantic version (tools/commits.mjs), written to
// package.json and package-lock.json, a CHANGELOG.md section, a release commit and a tag. Run it on a checkout of main
// after each merge. Main takes changes only through a pull request, so the release commit goes up on a release/vX.Y.Z
// branch with the tag, and its pull request is merged with a merge commit, which keeps the tagged commit on main.
//
//   npm run release                 make the release
//   npm run release -- --dry-run    say what it would do
//   npm run release -- --check      fail if commits since the last tag change the version and aren’t released (CI on main)

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { changelogSection, nextVersion } from './commits.mjs';

const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim();
const dry = process.argv.includes('--dry-run');
const check = process.argv.includes('--check');

const tag = git('describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*.[0-9]*.[0-9]*');
const current = tag.slice(1);
const out = git('log', '--no-merges', '--format=%B%x1e', `${tag}..HEAD`);
const messages = out
  .split('\x1e')
  .map((m) => m.trim())
  .filter(Boolean);
const next = nextVersion(current, messages);

if (check) {
  if (next) {
    console.error(
      `✖ ${messages.length} commits since ${tag} move the version to ${next}, and it isn’t released. Run npm run release on main and push the commit and its tag.`,
    );
    process.exit(1);
  }
  console.log(`release: ${tag} is current.`);
  process.exit(0);
}
if (!next) {
  console.log(`release: nothing since ${tag} changes the version.`);
  process.exit(0);
}
const date = new Date().toISOString().slice(0, 10);
const section = changelogSection(next, date, messages);
if (dry) {
  console.log(`release: ${current} → ${next}\n\n${section}`);
  process.exit(0);
}
if (git('status', '--porcelain')) throw new Error('Commit or set aside your changes first: a release commit holds only the release.');
for (const f of ['package.json', 'package-lock.json']) {
  const j = JSON.parse(readFileSync(f, 'utf8'));
  j.version = next;
  if (j.packages?.['']) j.packages[''].version = next;
  writeFileSync(f, `${JSON.stringify(j, null, 2)}\n`);
}
let log = '';
try {
  log = readFileSync('CHANGELOG.md', 'utf8');
} catch {}
const head = '# Changelog\n\nEvery release of Postbox, newest first. Written by `npm run release` from the commits since the last one.\n\n';
writeFileSync('CHANGELOG.md', head + section + (log.startsWith(head) ? `\n${log.slice(head.length)}` : ''));
git('add', 'package.json', 'package-lock.json', 'CHANGELOG.md');
git('commit', '-m', `chore(release): v${next}`);
git('tag', '-a', `v${next}`, '-m', `Postbox ${next}`);
console.log(
  `release: v${next}. Push it with: git push origin HEAD:refs/heads/release/v${next} v${next}\n` +
    `Then open a pull request from release/v${next} to main, and merge it with a merge commit: a squash or a rebase would leave the tag off main.`,
);
