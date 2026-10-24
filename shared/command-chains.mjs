// Claude Code checks each part of a chained command against the rules on its own, splitting at &&, ||, ;, |, |&, & and
// newlines (code.claude.com/docs/en/permissions, “Compound commands”). So a rule for the whole text never matches it,
// and Allow once or Always allow with one would do nothing (#238). A command substitution is taken as a part too, as
// the same section says deny and ask rules find one there. Quoted text, escapes, a heredoc’s body, and the | or & of a
// redirect (>|, 2>&1, &>) aren’t separators, and $(( )) is arithmetic, where << is a shift. A backslash-newline is
// nothing, outside single quotes and a quoted heredoc’s body: the shell removes it before it reads the words (POSIX,
// “Escape Character”), so it can’t split an operator such as << or $(, nor end a line. A comment runs to the end of
// its line, and a quote in it opens nothing; in $'' a backslash escapes a quote.
//
// The write guard (#112, server/write-guard.mjs) and the panel’s effective view (permission-match.mjs) check each
// command the shell would run, from the same scan (splitCommand). A process substitution, <( ) or >( ), runs one as
// $( ) does, and a heredoc’s body is commands when a shell is on its line (bash <<EOF, cat <<EOF | bash), which also
// chains the command. Where the scan can’t be sure, it reads the text as commands too, so whatever might run there is
// still checked: after a quote that never ends, which the shell refuses; a body with no delimiter line, since its <<
// may have been a shift; and, nested past MAX_DEPTH, every piece between operators.

// Commands that run what they read: a heredoc’s body on their line is commands, not data.
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'source', '.']);
// How deep substitutions and shell bodies may nest before read() gives up on the shell's reading for a coarse split.
const MAX_DEPTH = 64;
const TOO_DEEP = new RangeError('The command nests too deep to read.');

/** Where the text at k goes on, past any backslash-newlines. */
function past(cmd, k) {
  while (cmd.startsWith('\\\n', k)) k += 2;
  return k;
}

/** The character before k, past any backslash-newlines; a backslash when one escapes it. */
function before(cmd, k) {
  while (k > 1 && cmd.startsWith('\\\n', k - 2)) k -= 2;
  let escapes = 0;
  while (cmd[k - 2 - escapes] === '\\') escapes++;
  return escapes % 2 ? '\\' : (cmd[k - 1] ?? '');
}

/**
 * @typedef {{ parts: string[], chained: boolean, depth: number }} Found  the commands a scan found, whether it chains,
 *   and how deep in substitutions and shell bodies the scan is
 */

/** @param {string} cmd @returns {Found} */
function read(cmd) {
  const found = { parts: [], chained: false, depth: 0 };
  try {
    scan(cmd, 0, found, false);
    return found;
  } catch (e) {
    if (e !== TOO_DEEP) throw e;
    // Each piece between operators is taken as a command, so none that might run goes unchecked.
    return {
      parts: cmd
        .split(/[\n;&|`()]/)
        .map((p) => p.trim())
        .filter(Boolean),
      chained: true,
      depth: 0,
    };
  }
}

/** Whether a command chains, by a scan from the left that skips what isn’t shell syntax. @param {string} cmd */
export const chains = (cmd) => read(cmd).chained;

/**
 * The commands a command runs, each as its text: `a && b $(c)` → ['a', 'c', 'b $(c)']. A heredoc’s body stays in the
 * text of the command that reads it.
 * @param {string} cmd
 */
export const splitCommand = (cmd) => read(String(cmd ?? '')).parts;

/**
 * @typedef {{ cmd: string, found: Found, sub: boolean, quote: string, open: number, arith: number, braces: number,
 *   parens: number, start: number, line: number, last: number, heredocs: Heredoc[], done: boolean }} Scan
 *   where a scan is: the open quote, and where its text starts; how many $(( )) (where << is a shift), ${ } (where #
 *   starts no comment) and ( are open; where the current command and line start; where the text ends before any
 *   blanks, as a newline before that chains (-1 until one asks); the heredocs that start on the line; and whether a )
 *   ended the substitution
 */

/**
 * Reads cmd from `from` to its end, or with sub to the ) that ends a command substitution, into found; returns where
 * it stopped. line is where the line the scan starts in starts, for a shell before a substitution (bash -c "$(…)").
 * @param {string} cmd @param {number} from @param {Found} found @param {boolean} sub @param {number} [line]
 */
function scan(cmd, from, found, sub, line = from) {
  if (++found.depth > MAX_DEPTH) throw TOO_DEEP;
  /** @type {Scan} */
  const s = { cmd, found, sub, quote: '', open: 0, arith: 0, braces: 0, parens: 0, start: from, line, last: -1, heredocs: [], done: false };
  let i = from;
  for (; i < cmd.length; i++) {
    i = quoting(s, i) ?? operator(s, i);
    if (s.done) break;
  }
  add(found, cmd.slice(s.start, i));
  if (s.quote) scan(cmd, s.open, found, false);
  found.depth--;
  return i;
}

/**
 * Reads the character at i when it’s quoted or escaped, opens a quote, or starts a command substitution; returns where
 * the scan goes on from, or null for any other.
 * @param {Scan} s @param {number} i
 */
function quoting(s, i) {
  const { cmd } = s;
  const c = cmd[i];
  const n = past(cmd, i + 1); // the next character
  if (s.quote === "'" || s.quote === "$'") {
    if (c === "'") s.quote = '';
    else if (c === '\\' && s.quote === "$'") i++;
    return i;
  }
  if (c === '\\') return i + 1;
  if (c === '`') return backquoted(cmd, i, s.found);
  if (c === '$' && cmd[n] === '(' && cmd[past(cmd, n + 1)] !== '(') return substitution(cmd, n + 1, s.found, s.line);
  if (s.quote === '"') {
    if (c === '"') s.quote = '';
    return i;
  }
  if (c === '$' && cmd[n] === '$') return n; // $$, the shell’s process id
  if (c !== "'" && c !== '"' && !(c === '$' && cmd[n] === "'")) return null;
  s.quote = c === '$' ? "$'" : c;
  const at = c === '$' ? n : i;
  s.open = at + 1;
  return at;
}

/**
 * Reads the character at i outside quotes: an operator, a comment or a heredoc; returns where the scan goes on from.
 * @param {Scan} s @param {number} i
 */
function operator(s, i) {
  const { cmd, found } = s;
  const c = cmd[i];
  const n = past(cmd, i + 1);
  if (c === '$' && cmd[n] === '{') {
    s.braces++;
    return n;
  }
  if (c === '$' && cmd[n] === '(') {
    s.arith++; // a $( that isn’t a substitution is $((
    return past(cmd, n + 1);
  }
  if (s.arith && c === ')' && cmd[n] === ')') {
    s.arith--;
    return n;
  }
  if (s.arith && !separates(cmd, i, n)) return i; // in arithmetic, only a separator still counts, to be safe
  if ((c === '<' || c === '>') && cmd[n] === '(') return substitution(cmd, n + 1, found, s.line);
  if (c === '#' && !s.braces && ' \t\n;&|()<>'.includes(before(cmd, i))) {
    const end = cmd.indexOf('\n', i); // a comment, to the end of its line
    return (end < 0 ? cmd.length : end) - 1;
  }
  if (c === '<' && cmd[n] === '<' && !s.braces) {
    const m = past(cmd, n + 1); // <<< is a here-string, whose word is scanned as any other
    return cmd[m] === '<' ? m : heredocWord(cmd, m, s.heredocs) - 1;
  }
  if (c === '\n' && s.heredocs.length) return afterHeredocs(cmd, i, s.heredocs.splice(0), found, readsCommands(cmd.slice(s.line, i))) - 1;
  if (s.braces && c === '}') s.braces--;
  else if (c === '(') s.parens++;
  else if (c === ')' && s.parens) s.parens--;
  else if (c === ')') s.done = s.sub;
  else if (separates(cmd, i, n)) {
    if (c === '\n' && s.last < 0) s.last = cmd.trimEnd().length;
    if (c !== '\n' || i < s.last) found.chained = true;
    if (c === '\n') s.line = i + 1;
    add(found, cmd.slice(s.start, i));
    s.start = i + 1;
  }
  return i;
}

/** Adds a command’s text to found, without the blanks and backslash-newlines around it. */
function add(found, text) {
  let part = text.trim();
  while (part.startsWith('\\\n')) part = part.slice(2).trim();
  if (part) found.parts.push(part);
}

/** Whether the character at i, outside quotes, ends a command: ; | & or a newline, but not the | or & of a redirect. */
function separates(cmd, i, n) {
  const c = cmd[i];
  if (c === '|') return before(cmd, i) !== '>';
  if (c === '&') return !'<>'.includes(before(cmd, i)) && cmd[n] !== '>';
  return c === ';' || c === '\n';
}

/** Whether a line runs its heredocs’ bodies: a shell is on it (cat <<EOF | bash, bash <<EOF, source /dev/stdin). */
function readsCommands(text) {
  return text.split(/\s+/).some((w) => SHELLS.has(w.slice(w.lastIndexOf('/') + 1)));
}

/** Reads the command substitution that starts at k, to its ), into found: it runs. Returns where it ends. */
function substitution(cmd, k, found, line) {
  found.chained = true;
  return scan(cmd, k, found, true, line);
}

/** Reads the command substitution in backquotes at i into found. Returns where it ends. */
function backquoted(cmd, i, found) {
  let j = i + 1;
  let text = '';
  for (; j < cmd.length && cmd[j] !== '`'; j++) {
    if (cmd[j] === '\\' && '$`\\'.includes(cmd[j + 1] ?? '')) j++; // in ` `, a backslash escapes only these
    text += cmd[j];
  }
  found.chained = true;
  scan(text, 0, found, false);
  return j;
}

// A heredoc as the shell reads it (POSIX, “Here-Document”): << or <<-, then a word, which ends at a blank or an
// operator outside quotes. The delimiter is the word after quote removal; quoting any of it, or a backslash (not a
// backslash-newline, which is nothing), means the body isn’t expanded. The body ends at the first line that is the
// delimiter, after its leading tabs for <<-; with no such line, at the end of the command, as bash reads it (with a
// warning).
/** @typedef {{ word: string, tabs: boolean, quoted: boolean }} Heredoc */

/**
 * Reads the word of a heredoc whose << ends before `at` into heredocs; returns where the command goes on. A word whose
 * quote never ends is no heredoc's: the command goes on at it, to be read as any other text.
 * @param {string} cmd @param {number} at @param {Heredoc[]} heredocs
 */
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
    } else if (c === '$' && (cmd[j + 1] === "'" || cmd[j + 1] === '"'))
      continue; // $'' and $"" quote, as '' and ""
    else if (c === "'" || c === '"') {
      quote = c;
      quoted = true;
    } else if (' \t\n;&|<>()'.includes(c)) break;
    else word += c;
  }
  if (quote) return at;
  if (word || quoted) heredocs.push({ word, tabs, quoted });
  return j;
}

/**
 * Where the command goes on after the heredoc bodies that start at the newline at i: at the newline after the last
 * one’s delimiter line, or its end. The command substitutions in an expanded body run, and a shell runs its body:
 * their commands go into found. A body with no delimiter line is read as commands too, since the << may not have been
 * a heredoc’s (1 << 2 is a shift in (( ))). In an expanded body a backslash-newline joins the lines, before the
 * delimiter is looked for.
 * @param {string} cmd @param {number} i @param {Heredoc[]} heredocs @param {Found} found @param {boolean} shell
 */
function afterHeredocs(cmd, i, heredocs, found, shell) {
  let at = i;
  for (const { word, tabs, quoted } of heredocs) {
    const start = at + 1;
    let end = -1; // where the body ends: at its delimiter’s line, or (-1) with the command
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
    const body = cmd.slice(start, end < 0 ? cmd.length : end);
    const text = quoted ? body : unjoin(body);
    if (!quoted) substitutions(text, found);
    if (!shell && end >= 0) continue;
    const had = found.parts.length;
    scan(text, 0, { ...found, chained: false }, false);
    // What a shell runs from its body, no rule for the whole command can name.
    if (shell && found.parts.length > had) found.chained = true;
  }
  return at;
}

/** Text with its backslash-newlines taken out, as the shell does in an expanded body (\\ is one backslash, kept). */
const unjoin = (text) => text.replace(/\\(.)/gs, (s, e) => (e === '\n' ? '' : s));

/** Reads the commands an expanded heredoc body runs into found: each $( ) or ` ` that no backslash escapes. */
function substitutions(body, found) {
  for (let k = 0; k < body.length; k++) {
    if (body[k] === '\\') k++;
    else if (body[k] === '`') k = backquoted(body, k, found);
    else if (body[k] === '$' && body[k + 1] === '(' && body[k + 2] !== '(') k = substitution(body, k + 2, found);
  }
}
