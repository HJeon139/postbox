// The words of what a request may cover (request-floor.mjs, #296): a command’s words as the shell splits them, the
// paths it names, and the person’s words, compared whole. Moved out of server/request-floor.mjs.

import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

/**
 * A command’s words as the shell would split them, with quotes removed, or [] when it can’t be sure (an unclosed
 * quote). Nothing is expanded: a $( ) stays text, and the command it holds is a part of its own (splitCommand).
 * @param {string} s @returns {string[]}
 */
export function shellWords(s) {
  const out = [];
  /** @type {string|null} */
  let cur = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (/\s/.test(c)) {
      if (cur !== null) out.push(cur);
      cur = null;
    } else if (c === "'") {
      const end = s.indexOf("'", i + 1);
      if (end < 0) return [];
      cur = (cur ?? '') + s.slice(i + 1, end);
      i = end;
    } else if (c === '"') {
      let j = i + 1;
      let text = '';
      for (; j < s.length && s[j] !== '"'; j++) text += s[j] === '\\' && /["\\$`]/.test(s[j + 1] ?? '') ? s[++j] : s[j];
      if (j >= s.length) return [];
      cur = (cur ?? '') + text;
      i = j;
    } else cur = (cur ?? '') + (c === '\\' ? (s[++i] ?? '') : c);
  }
  if (cur !== null) out.push(cur);
  return out;
}

// A path a request can’t read from: from / or ~, through .., a hidden file or folder (.env, .git/config,
// .claude/settings.local.json), a $variable or a `command`, or a glob, whose matches Postbox can’t see.
const OUTSIDE = /^[~/]|[$`*?[\]{}]|(?:^|\/)\.\.(?:\/|$)|(?:^|\/)\.[^./]/;

/**
 * Whether a word a read, a git path or a body file names stays in the project, so a request can’t publish a secret in
 * a PR’s body (#557’s review): not OUTSIDE, and in the folder once its links are followed.
 * @param {string} w @param {string|null} [folder]  the agent’s folder, to follow links from
 */
export function inProject(w, folder = null) {
  const path = w.startsWith('-') && w.includes('=') ? w.slice(w.indexOf('=') + 1) : w;
  if (OUTSIDE.test(path)) return false;
  if (!folder) return true;
  try {
    // A path that isn’t there yet is where its nearest folder that is leads.
    let at = resolve(folder, path);
    while (!existsSync(at) && dirname(at) !== at) at = dirname(at);
    const rel = relative(realpathSync(folder), realpathSync(at));
    return !rel.startsWith('..') && !isAbsolute(rel);
  } catch {
    return false;
  }
}

/**
 * Whether a title, a body or a message is text: no $variable or `command`, which the shell fills in ("$GH_TOKEN",
 * "$(cat .env)"), unless it’s the quoted here-document Claude Code writes a body with, where nothing expands. Its
 * end word must close it once, on the last line: an earlier one would end it there and run the rest.
 * @param {string} v
 */
export function isText(v) {
  if (!/[$`]/.test(v)) return true;
  const doc = /^\$\(cat <<-?'([A-Za-z_]+)'\n([\s\S]*)\n\1\n?\)$/.exec(v);
  return doc !== null && !doc[2].split('\n').some((line) => line.trim() === doc[1]);
}

/**
 * The person’s words one by one, lowercase and without the punctuation around them, so a name is compared whole:
 * eon139/postbox isn’t hjeon139/postbox, and …/issues/12 isn’t …/issues/123.
 * @param {string} named
 */
export const tokensOf = (named) =>
  new Set(
    named
      .split(/\s+/)
      .map((w) => w.replace(/^[(<"'‘“`]+|[)>"'’”`.,;:!?]+$/g, '').replace(/\/$/, ''))
      .filter(Boolean),
  );

/** Whether the person named a repository, as owner/name or by its link. @param {Set<string>} tokens @param {string} repo */
export const namesRepo = (tokens, repo) => tokens.has(repo.toLowerCase()) || tokens.has(`https://github.com/${repo.toLowerCase()}`);
