// The prompt-surface gate’s two decisions (SECURITY.md, “Prompt changes”):
//
//   node tools/prompt-gate.mjs touched <paths file>          the changed files (one per line, on stdin) that are prompt
//                                                            surface; exit 0 either way
//   node tools/prompt-gate.mjs findings <base.json> <head.json>  SkillSpector’s findings the head adds, as Markdown;
//                                                            exit 1 if any is high or critical
//   node tools/prompt-gate.mjs spoofs <check> <gate> <root> <file>...  the head’s workflow files (under root) that
//                                                            could post a check named <check>; exit 1 if any
//   node tools/prompt-gate.mjs notices <touched file>        the run page’s notices: what to read before approving
//   node tools/prompt-gate.mjs comment <touched file>        the pull request comment that says the same, as Markdown
// The last two read REPO, PR, RUN_URL and TOO_MANY (true when over the 3,000 files GitHub lists) from the environment.
//
// The paths file lists globs, one per line, with # for comments: `*` matches within a folder, `**/` any folders.
// The gate workflow runs this from main’s checkout, never the pull request’s, so a pull request can’t change its own
// verdict.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { blocks, findingsReport, newFindings } from './prompt-findings.mjs';

/** The globs in a paths file. @param {string} text */
export const globsOf = (text) =>
  text
    .split('\n')
    .map((l) => l.replace(/#.*/, '').trim())
    .filter(Boolean);

/** A glob as an anchored regular expression: two stars and a slash are any folders, two stars anything, one star anything within a folder. */
export function globRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (glob.startsWith('**/', i)) {
      re += '(?:.*/)?';
      i += 2;
    } else if (glob.startsWith('**', i)) {
      re += '.*';
      i += 1;
    } else if (c === '*') re += '[^/]*';
    else re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** The files among `changed` that some glob matches. @param {string[]} changed @param {string[]} globs */
export function touched(changed, globs) {
  const res = globs.map(globRegExp);
  return changed.filter((f) => res.some((re) => re.test(f)));
}

/**
 * The events a workflow runs on, from its `on:` key: inline (`on: push`, `on: [a, b]`) or as the keys under it.
 * Enough to tell the gate’s own `pull_request_target` from anything else, not a YAML parser.
 * @param {string} yaml
 */
export function triggersOf(yaml) {
  const lines = yaml.split('\n');
  const at = lines.findIndex((l) => /^["']?on["']?\s*:/.test(l));
  if (at < 0) return [];
  const inline = lines[at]
    .replace(/^\S+\s*:/, '')
    .replace(/#.*/, '')
    .trim();
  if (inline)
    return inline
      .replace(/[[\]]/g, '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  const events = [];
  let indent = -1;
  for (const l of lines.slice(at + 1)) {
    if (/^[^\s#]/.test(l)) break;
    const m = /^(\s+)(?:-\s+)?([A-Za-z_]+)\s*:?\s*(?:#.*)?$/.exec(l);
    if (!m) continue;
    if (indent < 0) indent = m[1].length;
    if (m[1].length === indent) events.push(m[2]);
  }
  return events;
}

/**
 * The workflow files a pull request brings that could post a check under the gate’s name, which a ruleset can’t tell
 * from the gate’s: GitHub matches a required check by its name and app, and both are GitHub Actions. The gate’s own
 * file may carry the name only while it still runs on pull_request_target alone, since then main’s copy is what runs.
 * A name built by an expression gets past this, which is why .github/ needs approval too.
 * @param {string} check @param {string} gate  the gate’s path @param {{ path: string, text: string }[]} files
 */
export function spoofs(check, gate, files) {
  return files.filter(({ path, text }) => text.includes(check) && (path !== gate || triggersOf(text).join() !== 'pull_request_target')).map((f) => f.path);
}

/** A file’s diff in a pull request: GitHub anchors each one by the SHA-256 of its path. */
export const diffUrl = (repo, pr, path) => `https://github.com/${repo}/pull/${pr}/files#diff-${createHash('sha256').update(path).digest('hex')}`;

/** Text as a workflow command’s message, which ends at a newline and reads % as an escape. */
const commandText = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

/**
 * The notices the gate’s run page shows above its jobs, where the approval dialog opens: each prompt-surface file with
 * its diff, then where the rendered text of what agents read is. The dialog itself can’t say more.
 * @param {string[]} files @param {{ repo: string, pr: string|number, tooMany?: boolean }} where
 */
export function notices(files, { repo, pr, tooMany = false }) {
  return [
    ...(tooMany ? ['::notice title=Review before approving::More than the 3,000 files GitHub lists changed, so some can’t be checked here.'] : []),
    ...files.map((f) => `::notice title=Review before approving::${commandText(`${f} changed: ${diffUrl(repo, pr, f)}`)}`),
    `::notice title=Review before approving::${commandText(`What agents will read, before and after, is in the “Prompt surface diff and SkillSpector” job summary: https://github.com/${repo}/pull/${pr}/checks`)}`,
  ];
}

/** A path as inline code, fenced past any backticks in it, so a file name can’t be read as Markdown or a mention. */
function code(s) {
  const text = String(s).replace(/[\r\n]+/g, ' ');
  const fence = '`'.repeat(Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length)) + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** The first line of the gate’s comment, which finds it again to update it rather than add another. */
export const COMMENT_MARK = '<!-- prompt-surface-gate -->';

/**
 * The comment the gate keeps on a pull request that touches the prompt surface: the files, what to check, and where
 * to approve. Built from file names alone, never the pull request’s title or text.
 * @param {string[]} files @param {{ repo: string, pr: string|number, runUrl: string, tooMany?: boolean }} where
 */
export function reviewComment(files, { repo, pr, runUrl, tooMany = false }) {
  if (!files.length && !tooMany) return `${COMMENT_MARK}\n**Prompt surface:** this pull request no longer changes what agents read, so it needs no approval.`;
  return [
    COMMENT_MARK,
    '**Prompt surface: this pull request changes what agents read, so it waits for your approval.**',
    '',
    'The files:',
    ...files.map((f) => `- [${code(f)}](${diffUrl(repo, pr, f)})`),
    ...(tooMany ? ['- More than the 3,000 files GitHub lists changed, so some can’t be checked here. Review the whole diff.'] : []),
    '',
    'What to check before you approve:',
    '- Does it loosen a rule an agent follows, such as when to show a review or confirm block (`server/adapters/guide.mjs`, the tool descriptions in `server/mcp.mjs`)?',
    '- Does it tell an agent to send data somewhere, fetch or run something new, or take files, web pages or other agents’ messages as instructions?',
    '- Does a persona’s text change what the agent may do without asking you?',
    '- Does it change how permissions, cards or reviews are decided, or the gate itself (`.github/`, `tools/prompt-*.mjs`)?',
    '',
    `Read what agents will see, before and after, in the “Prompt surface diff and SkillSpector” summary under [Checks](https://github.com/${repo}/pull/${pr}/checks). Then approve in [the gate’s run](${runUrl}): **Review deployments**, then **Approve and deploy**. Each push asks again.`,
  ].join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, a, b] = process.argv.slice(2);
  if (cmd === 'touched' && a) {
    const changed = readFileSync(0, 'utf8').split('\n').filter(Boolean);
    for (const f of touched(changed, globsOf(readFileSync(a, 'utf8')))) console.log(f);
  } else if (cmd === 'spoofs' && process.argv.length > 6) {
    const [check, gate, root, ...paths] = process.argv.slice(3);
    const found = spoofs(
      check,
      gate,
      paths.map((path) => ({ path, text: readFileSync(`${root}/${path}`, 'utf8') })),
    );
    for (const f of found) console.log(f);
    process.exitCode = found.length ? 1 : 0;
  } else if ((cmd === 'notices' || cmd === 'comment') && a) {
    const files = readFileSync(a, 'utf8').split('\n').filter(Boolean);
    const where = { repo: process.env.REPO ?? '', pr: process.env.PR ?? '', runUrl: process.env.RUN_URL ?? '', tooMany: process.env.TOO_MANY === 'true' };
    console.log(cmd === 'notices' ? notices(files, where).join('\n') : reviewComment(files, where));
  } else if (cmd === 'findings' && a && b) {
    const [base, head] = [a, b].map((f) => JSON.parse(readFileSync(f, 'utf8')));
    console.log(findingsReport(base, head));
    process.exitCode = newFindings(base, head).some(blocks) ? 1 : 0;
  } else {
    console.error(
      'Usage: node tools/prompt-gate.mjs touched <paths file> < changed | findings <base.json> <head.json> | spoofs <check> <gate> <root> <file>... | notices|comment <touched file>',
    );
    process.exitCode = 2;
  }
}
