// Claude Code checks each part of a chained command against the rules on its own, splitting at &&, ||, ;, |, |&, & and
// newlines (code.claude.com/docs/en/permissions, “Compound commands”). So a rule for the whole text never matches it,
// and Allow once or Always allow with one would do nothing (#238). A command substitution is taken as a part too, as
// the same section says deny and ask rules find one there. Quoted text, escapes (a backslash-newline too), a heredoc’s
// body, and the | or & of a redirect (>|, 2>&1, &>) aren’t separators, and $(( )) is arithmetic, where << is a shift.

/** Whether a command chains, by a scan from the left that skips what isn’t shell syntax. */
export function chains(cmd) {
  let quote = '';
  let arith = 0; // how many $(( )) are open: a << in one is a shift
  /** @type {Heredoc[]} the heredocs that start on the current line */
  const heredocs = [];
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote === "'") {
      if (c === "'") quote = '';
    } else if (c === '\\') i++;
    else if (c === '`' || (c === '$' && cmd[i + 1] === '(' && cmd[i + 2] !== '(')) return true;
    else if (quote === '"') {
      if (c === '"') quote = '';
    } else if (c === "'" || c === '"') quote = c;
    else if (c === '$' && cmd.startsWith('((', i + 1)) {
      arith++;
      i += 2;
    } else if (arith && c === ')' && cmd[i + 1] === ')') {
      arith--;
      i++;
    } else if (c === '<' && cmd[i + 1] === '<' && !arith) {
      // <<< is a here-string, whose word is scanned as any other.
      i = cmd[i + 2] === '<' ? i + 2 : heredocWord(cmd, i + 2, heredocs) - 1;
    } else if (c === '\n' && heredocs.length) {
      i = afterHeredocs(cmd, i, heredocs.splice(0));
      if (i < 0) return true;
      i--;
    } else if (c === ';' || (c === '\n' && cmd.slice(i).trim()) || (c === '|' && cmd[i - 1] !== '>')) return true;
    else if (c === '&' && !'<>'.includes(cmd[i - 1] ?? '') && cmd[i + 1] !== '>') return true;
  }
  return false;
}

// A heredoc as the shell reads it (POSIX, “Here-Document”): << or <<-, then a word, which ends at a blank or an
// operator outside quotes. The delimiter is the word after quote removal; quoting any of it, or a backslash, means the
// body isn’t expanded. The body ends at the first line that is the delimiter, after its leading tabs for <<-; with no
// such line, at the end of the command, as bash reads it (with a warning).
/** @typedef {{ word: string, tabs: boolean, quoted: boolean }} Heredoc */

/** Reads the word of a heredoc whose << ends before `at` into heredocs; returns where the command goes on. */
function heredocWord(cmd, at, heredocs) {
  const tabs = cmd[at] === '-';
  let j = tabs ? at + 1 : at;
  while (cmd[j] === ' ' || cmd[j] === '\t') j++;
  let word = '';
  let quoted = false;
  for (; j < cmd.length && !' \t\n;&|<>()'.includes(cmd[j]); j++) {
    const q = cmd[j];
    if (q === '\\') {
      quoted = true;
      word += cmd[++j] ?? '';
    } else if (q === "'" || q === '"') {
      quoted = true;
      const end = cmd.indexOf(q, j + 1);
      const inner = cmd.slice(j + 1, end < 0 ? cmd.length : end);
      word += q === '"' ? inner.replace(/\\([$`"\\\n])/g, '$1') : inner;
      j = end < 0 ? cmd.length : end;
    } else word += q;
  }
  if (word || quoted) heredocs.push({ word, tabs, quoted });
  return j;
}

/**
 * Where the command goes on after the heredoc bodies that start at the newline at i: at the newline after the last
 * one’s delimiter line, or its end. -1 when an expanded body has a command substitution in it, which runs.
 * @param {string} cmd @param {number} i @param {Heredoc[]} heredocs
 */
function afterHeredocs(cmd, i, heredocs) {
  let at = i;
  for (const { word, tabs, quoted } of heredocs) {
    const start = at + 1;
    let end = cmd.length; // where the body ends: at its delimiter’s line, or with the command
    while (at < cmd.length) {
      const from = at + 1;
      const nl = cmd.indexOf('\n', from);
      at = nl < 0 ? cmd.length : nl;
      const line = cmd.slice(from, at);
      if ((tabs ? line.replace(/^\t+/, '') : line) !== word) continue;
      end = from;
      break;
    }
    if (!quoted && substitutes(cmd.slice(start, end))) return -1;
  }
  return at;
}

/** Whether an expanded heredoc body runs a command: a $( ) or ` ` that no backslash escapes. */
function substitutes(body) {
  for (let k = 0; k < body.length; k++) {
    if (body[k] === '\\') k++;
    else if (body[k] === '`' || (body[k] === '$' && body[k + 1] === '(' && body[k + 2] !== '(')) return true;
  }
  return false;
}
