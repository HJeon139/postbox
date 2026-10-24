// Claude Code checks each part of a chained command against the rules on its own, splitting at &&, ||, ;, |, |&, & and
// newlines (code.claude.com/docs/en/permissions, “Compound commands”). So a rule for the whole text never matches it,
// and Allow once or Always allow with one would do nothing (#238). A command substitution is taken as a part too, as
// the same section says deny and ask rules find one there. Quoted text, escapes, a heredoc’s body, and the | or & of a
// redirect (>|, 2>&1, &>) aren’t separators, and $(( )) is arithmetic, where << is a shift. A backslash-newline is
// nothing, outside single quotes and a quoted heredoc’s body: the shell removes it before it reads the words (POSIX,
// “Escape Character”), so it can’t split an operator such as << or $(, nor end a line.

/** Where the text at k goes on, past any backslash-newlines. */
function past(cmd, k) {
  while (cmd.startsWith('\\\n', k)) k += 2;
  return k;
}

/** The character before k, past any backslash-newlines. */
function before(cmd, k) {
  while (k > 1 && cmd.startsWith('\\\n', k - 2)) k -= 2;
  return cmd[k - 1] ?? '';
}

/** Whether a command chains, by a scan from the left that skips what isn’t shell syntax. */
export function chains(cmd) {
  let quote = '';
  let arith = 0; // how many $(( )) are open: a << in one is a shift
  /** @type {Heredoc[]} the heredocs that start on the current line */
  const heredocs = [];
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    const n = past(cmd, i + 1); // the next character
    if (quote === "'") {
      if (c === "'") quote = '';
    } else if (c === '\\') i++;
    else if (c === '`' || (c === '$' && cmd[n] === '(' && cmd[past(cmd, n + 1)] !== '(')) return true;
    else if (quote === '"') {
      if (c === '"') quote = '';
    } else if (c === "'" || c === '"') quote = c;
    else if (c === '$' && cmd[n] === '(') {
      arith++; // a $( that isn’t a substitution is $((
      i = past(cmd, n + 1);
    } else if (arith && c === ')' && cmd[n] === ')') {
      arith--;
      i = n;
    } else if (c === '<' && cmd[n] === '<' && !arith) {
      // <<< is a here-string, whose word is scanned as any other.
      const m = past(cmd, n + 1);
      i = cmd[m] === '<' ? m : heredocWord(cmd, m, heredocs) - 1;
    } else if (c === '\n' && heredocs.length) {
      i = afterHeredocs(cmd, i, heredocs.splice(0));
      if (i < 0) return true;
      i--;
    } else if (c === ';' || (c === '\n' && cmd.slice(i).trim()) || (c === '|' && before(cmd, i) !== '>')) return true;
    else if (c === '&' && !'<>'.includes(before(cmd, i)) && cmd[n] !== '>') return true;
  }
  return false;
}

// A heredoc as the shell reads it (POSIX, “Here-Document”): << or <<-, then a word, which ends at a blank or an
// operator outside quotes. The delimiter is the word after quote removal; quoting any of it, or a backslash (not a
// backslash-newline, which is nothing), means the body isn’t expanded. The body ends at the first line that is the
// delimiter, after its leading tabs for <<-; with no such line, at the end of the command, as bash reads it (with a
// warning).
/** @typedef {{ word: string, tabs: boolean, quoted: boolean }} Heredoc */

/** Reads the word of a heredoc whose << ends before `at` into heredocs; returns where the command goes on. */
function heredocWord(cmd, at, heredocs) {
  const tabs = cmd[at] === '-';
  let j = tabs ? past(cmd, at + 1) : at;
  while (cmd[j] === ' ' || cmd[j] === '\t') j = past(cmd, j + 1);
  let word = '';
  let quoted = false;
  let quote = '';
  for (; j < cmd.length; j++) {
    const c = cmd[j];
    if (c === '\\' && quote !== "'") {
      const e = cmd[++j] ?? '';
      if (e === '\n') continue; // a backslash-newline, which is nothing
      quoted = true;
      word += quote && !'$`"\\'.includes(e) ? c + e : e; // in "", a backslash escapes only these
    } else if (quote) {
      if (c === quote) quote = '';
      else word += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      quoted = true;
    } else if (' \t\n;&|<>()'.includes(c)) break;
    else word += c;
  }
  if (word || quoted) heredocs.push({ word, tabs, quoted });
  return j;
}

/**
 * Where the command goes on after the heredoc bodies that start at the newline at i: at the newline after the last
 * one’s delimiter line, or its end. -1 when an expanded body has a command substitution in it, which runs. In an
 * expanded body a backslash-newline joins the lines, before the delimiter is looked for.
 * @param {string} cmd @param {number} i @param {Heredoc[]} heredocs
 */
function afterHeredocs(cmd, i, heredocs) {
  let at = i;
  for (const { word, tabs, quoted } of heredocs) {
    const start = at + 1;
    let end = cmd.length; // where the body ends: at its delimiter’s line, or with the command
    const lineRe = quoted ? /[^\n]*/y : /(?:\\.|[^\n])*/sy;
    while (at < cmd.length) {
      const from = at + 1;
      lineRe.lastIndex = from;
      const raw = lineRe.exec(cmd)?.[0] ?? '';
      at = from + raw.length;
      const line = quoted ? raw : unjoin(raw);
      if ((tabs ? line.replace(/^\t+/, '') : line) !== word) continue;
      end = from;
      break;
    }
    if (!quoted && substitutes(unjoin(cmd.slice(start, end)))) return -1;
  }
  return at;
}

/** Text with its backslash-newlines taken out, as the shell does in an expanded body (\\ is one backslash, kept). */
const unjoin = (text) => text.replace(/\\(.)/gs, (s, e) => (e === '\n' ? '' : s));

/** Whether an expanded heredoc body runs a command: a $( ) or ` ` that no backslash escapes. */
function substitutes(body) {
  for (let k = 0; k < body.length; k++) {
    if (body[k] === '\\') k++;
    else if (body[k] === '`' || (body[k] === '$' && body[k + 1] === '(' && body[k + 2] !== '(')) return true;
  }
  return false;
}
