/**
 * The privacy checker for committed text, kept apart from its test so a CI tool can reuse it (#508). Its own file and
 * its test are checked like any other, so the examples in these comments name each part generically, and the test
 * builds its examples at run time.
 *
 * Known gaps, which it lets through:
 * - a token with a “_” and more name characters run on before or after it, where a word boundary never comes;
 * - a token or an address split across two lines, except a stream’s deltas, which are joined and checked again;
 * - a path whose slashes are JSON-escaped (a backslash before each “/”) or URL-encoded (“%2F”);
 * - a home written as “~” and a user name, and root’s home under “/root”;
 * - a leak after a zero byte early in a file, which is then counted as binary and not read;
 * - a real account named “me” or “you” in a slug, which reads as the placeholder;
 * - UTF-16 text, read as UTF-8 with a zero byte after each ASCII character;
 * - a Bearer token shorter than 20 characters, and a token under another scheme, such as Basic;
 * - a uid under another key, such as “user_id”, and account data under keys other than the six account fields;
 * - a uid with no quotes on its key, as YAML (“uid: 501”) and TOML (“uid = 501”) write it, since code and tests name
 *   uids so (a “uid: 1000” option to a function);
 * - an account key before an “=” after anything but a line’s start, white space, “{” or “,”, such as “;”;
 * - a connector a person named after one of claude.ai’s directory connectors;
 * - a connector’s tool ids, “mcp__claude_ai_<name>__<tool>”, where its name shows as surely as in mcp_servers.
 */

import { checkContentPrivacy, privateStrings, sameLine } from '../shared/privacy-rules.mjs';
import { joinedDeltas } from './joined-deltas.mjs';

export { checkContentPrivacy };

/** Where a violation in a file’s name says it is. */
const IN_FILE_NAME = 'in the file name';

/**
 * Checks a committed file’s name, by its path from the repository’s root: a name is published as surely as what the
 * file holds (#785).
 *
 * @param {string} path
 * @returns {string[]} list of violations found
 */
export function checkPathPrivacy(path) {
  return privateStrings(path).map(({ kind }) => `${kind} ${IN_FILE_NAME}`);
}

/**
 * Whether a violation is in a file’s name, so that a report mustn’t print the name. @param {string} violation
 */
function inFileName(violation) {
  return violation.endsWith(IN_FILE_NAME);
}

/**
 * Checks one committed file, by its path from the repository’s root, with the placeholders its joined deltas may hold.
 *
 * @param {string} path
 * @param {string} content
 * @param {(line: number) => number} [lineOf] the line to report for a line of content, when content is part of a file
 * @returns {string[]} list of violations found
 */
export function checkFilePrivacy(path, content, lineOf = sameLine) {
  const violations = checkContentPrivacy(content, lineOf);
  if (!path.endsWith('.jsonl')) return violations;
  const allowed = ALLOWED_JOINED.get(path) ?? [];
  for (const stream of joinedDeltas(content)) {
    const leaks = privateStrings(stream.text).filter(
      ({ kind, value }) => !allowed.some((placeholder) => placeholder.kind === kind && placeholder.value === value),
    );
    violations.push(...leaks.map(({ kind }) => `${kind} in the deltas joined from line ${lineOf(stream.firstLine)}`));
  }
  return violations;
}

/**
 * Placeholders a recorded stream’s joined deltas hold, by file: the prompt in permission-allow.jsonl names a made-up
 * project folder, “postbox”, where a home’s user name goes. Each entry is the kind and the exact string it allows.
 */
const MADE_UP_HOME = ['Users', 'postbox'].join('/'); // joined at run time, so this file doesn’t hold the path itself
const ALLOWED_JOINED = new Map([['tests/fixtures/claude-code/permission-allow.jsonl', [{ kind: 'home path', value: MADE_UP_HOME }]]]);

/** Whether a file is binary, as git decides it: a zero byte in its first 8,000. @param {Buffer} bytes */
export function isBinary(bytes) {
  return bytes.subarray(0, 8000).includes(0);
}

/**
 * Checks each file of a tree, its name and what it holds, read by its path, whatever its size. A binary file’s name is
 * checked, but not its bytes, and it isn’t counted; a file the reader can’t find is skipped.
 *
 * @param {string[]} paths paths from the repository’s root
 * @param {(path: string) => Buffer | null} read the file’s bytes, or null when it’s gone
 * @returns {{ checked: number, findings: { path: string, violations: string[] }[] }}
 */
export function checkFilesPrivacy(paths, read) {
  const findings = [];
  let checked = 0;
  for (const path of paths) {
    const bytes = read(path);
    if (bytes === null) continue;
    const violations = checkPathPrivacy(path);
    if (!isBinary(bytes)) {
      checked++;
      violations.push(...checkFilePrivacy(path, bytes.toString('utf8')));
    }
    if (violations.length > 0) findings.push({ path, violations });
  }
  return { checked, findings };
}

/**
 * The lines the tree’s privacy test (tests/process/privacy-tree.test.mjs) prints for checkFilesPrivacy’s findings, one
 * per file. A file whose name is private is named by its place in the list of paths, from 1, so CI’s public log doesn’t
 * repeat the name (#784).
 *
 * @param {string[]} paths the paths checked, in the order `git ls-files` lists them
 * @param {{ path: string, violations: string[] }[]} findings
 * @returns {string[]}
 */
export function treeFailures(paths, findings) {
  const named = (path, violations) => (violations.some(inFileName) ? `file ${paths.indexOf(path) + 1} of git ls-files` : path);
  return findings.map(({ path, violations }) => `  - ${named(path, violations)}: ${violations.join('; ')}`);
}
