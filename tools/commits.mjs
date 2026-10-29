// Conventional Commits and semantic versions: what a commit message must look like, and what version a set of commits
// moves the project to. Pure functions; tools/lint-commits.mjs and tools/release.mjs read git, and tests feed these
// messages directly. https://www.conventionalcommits.org/en/v1.0.0/ and https://semver.org/
//
//   feat(rail): show the build’s version under Personas      a feature: the minor version goes up
//   fix: a stopped turn leaves no step running                a bug fix: the patch version goes up
//   feat!: personas move to the home folder                    a breaking change: the major version goes up
//
// A breaking change is marked with `!` before the colon, or a `BREAKING CHANGE:` footer. Even before 1.0.0, a
// breaking change moves the major version, as decided for Postbox.
//
// A commit and its git revert, both since the last release, are left out of the version and the changelog: together
// they changed nothing (withoutReverted).

/** The types a header may use. Only feat, fix and perf change the version on their own. */
export const TYPES = ['feat', 'fix', 'perf', 'refactor', 'docs', 'test', 'build', 'ci', 'chore', 'style', 'revert'];

const HEADER = /^(?<type>[a-z]+)(?:\((?<scope>[a-z0-9][a-z0-9._/-]*)\))?(?<bang>!)?: (?<subject>\S.*)$/;

/**
 * Reads a commit message. A merge commit, and the release commit tools/release.mjs makes, are left alone.
 * @param {string} message
 * @returns {{ ok: true, type: string, scope: string|null, breaking: boolean, subject: string, skip?: boolean } | { ok: false, error: string }}
 */
export function parseCommit(message) {
  const text = String(message ?? '').replace(/\r\n/g, '\n');
  const header = text.split('\n')[0].trim();
  if (/^Merge (pull request|branch|remote-tracking branch|[0-9a-f]{7,})\b/.test(header))
    return { ok: true, type: 'merge', scope: null, breaking: false, subject: header, skip: true };
  // git revert’s own header, Revert "…", is a revert.
  if (/^Revert ".+"$/.test(header)) return { ok: true, type: 'revert', scope: null, breaking: false, subject: header };
  const m = HEADER.exec(header);
  if (!m?.groups)
    return {
      ok: false,
      error: `“${header}” isn’t a conventional commit header: write type(scope): what changed, such as “fix(blocks): an answered confirm stays answered”.`,
    };
  const { type, scope, bang, subject } = m.groups;
  if (!TYPES.includes(type)) return { ok: false, error: `“${type}” isn’t a commit type. Use one of: ${TYPES.join(', ')}.` };
  if (header.length > 100) return { ok: false, error: `The header is ${header.length} characters; keep it to 100, and put the rest in the body.` };
  const lines = text.split('\n');
  if (lines.length > 1 && lines[1].trim() !== '') return { ok: false, error: 'Leave a blank line between the header and the body.' };
  const breaking = Boolean(bang) || /^BREAKING[ -]CHANGE: \S/m.test(lines.slice(1).join('\n'));
  return { ok: true, type, scope: scope ?? null, breaking, subject, ...(type === 'chore' && scope === 'release' ? { skip: true } : {}) };
}

/**
 * The messages of commits since the last release, less each commit `git revert` undid and its revert, when both are
 * among them. Reverting a revert brings the commit back: the newest pair goes first. A revert of a commit an earlier
 * release holds stays.
 * @param {{ sha: string, message: string }[]} commits  newest first, as git log gives them
 * @returns {string[]}
 */
export function withoutReverted(commits) {
  const gone = new Set();
  for (const c of commits) {
    if (gone.has(c.sha)) continue;
    const m = /^This reverts commit ([0-9a-f]{7,40})\b/m.exec(String(c.message));
    if (parseCommit(c.message).type !== 'revert' || !m) continue;
    const undone = commits.find((o) => o !== c && !gone.has(o.sha) && o.sha.startsWith(m[1]));
    if (!undone) continue;
    gone.add(c.sha);
    gone.add(undone.sha);
  }
  return commits.filter((c) => !gone.has(c.sha)).map((c) => c.message);
}

/** What one commit asks of the version: 'major', 'minor', 'patch' or null. */
export function bumpOf(message) {
  const c = parseCommit(message);
  if (!c.ok || c.skip) return null;
  if (c.breaking) return 'major';
  if (c.type === 'feat') return 'minor';
  if (c.type === 'fix' || c.type === 'perf') return 'patch';
  return null;
}

const RANK = { major: 3, minor: 2, patch: 1 };

/**
 * The version a release moves to from `current`, given the commits since the last one: the largest bump among them.
 * Null when none of them changes the version (only docs, tests, chores and the like).
 * @param {string} current  @param {string[]} messages
 */
export function nextVersion(current, messages) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(current));
  if (!m) throw new Error(`“${current}” isn’t a version like 1.2.3.`);
  const bump = messages.map(bumpOf).reduce((a, b) => ((RANK[b] ?? 0) > (RANK[a] ?? 0) ? b : a), null);
  if (!bump) return null;
  const [maj, min, pat] = m.slice(1).map(Number);
  if (bump === 'major') return `${maj + 1}.0.0`;
  if (bump === 'minor') return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
}

/** The changelog section for a release: breaking changes, features and fixes, each commit’s subject once. */
export function changelogSection(version, date, messages) {
  const groups = { 'Breaking changes': [], Features: [], Fixes: [] };
  for (const msg of messages) {
    const c = parseCommit(msg);
    if (!c.ok || c.skip) continue;
    const line = `- ${c.scope ? `**${c.scope}:** ` : ''}${c.subject}`;
    if (c.breaking) groups['Breaking changes'].push(line);
    else if (c.type === 'feat') groups.Features.push(line);
    else if (c.type === 'fix' || c.type === 'perf') groups.Fixes.push(line);
  }
  const body = Object.entries(groups)
    .filter(([, l]) => l.length)
    .map(([h, l]) => `### ${h}\n\n${l.join('\n')}`)
    .join('\n\n');
  return `## ${version} (${date})\n\n${body}\n`;
}
