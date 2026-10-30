// The words of what a request may cover (request-floor.mjs, #296): a command’s words as the shell splits them, the
// paths it names, and the person’s words, compared whole. Moved out of server/request-floor.mjs.

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

/**
 * Whether a word a read, a git path or a body file names stays in the project: never a path from / or ~, a ..
 * segment, or a $variable or a `command`, which could read ~/.config/gh/hosts.yml into a PR’s body.
 * @param {string} w
 */
export const inProject = (w) => !/^[~/]|[$`]|(?:^|\/)\.\.(?:\/|$)/.test(w.startsWith('-') && w.includes('=') ? w.slice(w.indexOf('=') + 1) : w);

/**
 * The person’s words one by one, lowercase and without the punctuation around them, so a name is compared whole:
 * eon139/postbox isn’t hjeon139/postbox, and …/issues/12 isn’t …/issues/123.
 * @param {string} named
 */
export const tokensOf = (named) =>
  new Set(
    named
      .split(/\s+/)
      .map((w) => w.replace(/^[(<"'‘“]+|[)>"'’”.,;:!?]+$/g, '').replace(/\/$/, ''))
      .filter(Boolean),
  );

/** Whether the person named a repository, as owner/name or by its link. @param {Set<string>} tokens @param {string} repo */
export const namesRepo = (tokens, repo) => tokens.has(repo.toLowerCase()) || tokens.has(`https://github.com/${repo.toLowerCase()}`);
