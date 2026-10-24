// Claude Code checks each part of a chained command against the rules on its own, splitting at &&, ||, ;, |, |&, & and
// newlines (code.claude.com/docs/en/permissions, “Compound commands”). So a rule for the whole text never matches it,
// and Allow once or Always allow with one would do nothing (#238). A command substitution is taken as a part too, as
// the same section says deny and ask rules find one there. Quoted text, escapes (a backslash-newline too), a heredoc’s
// body, and the | or & of a redirect (>|, 2>&1, &>) aren’t separators, and $(( )) is arithmetic.

/** Whether a command chains, by a scan from the left that skips what isn’t shell syntax. */
export function chains(cmd) {
  let quote = '';
  /** @type {string[]} the delimiters of heredocs that start on the current line */
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
    else if (c === '<' && cmd[i + 1] === '<' && cmd[i + 2] !== '<') {
      const m = /^<<-?[ \t]*(['"]?)(\w+)\1/.exec(cmd.slice(i));
      if (m) heredocs.push(m[2]);
      i += m ? m[0].length - 1 : 1;
    } else if (c === '\n' && heredocs.length) i = afterHeredocs(cmd, i, heredocs.splice(0)) - 1;
    else if (c === ';' || (c === '\n' && cmd.slice(i).trim()) || (c === '|' && cmd[i - 1] !== '>')) return true;
    else if (c === '&' && !'<>'.includes(cmd[i - 1] ?? '') && cmd[i + 1] !== '>') return true;
  }
  return false;
}

/** Where the command goes on after the heredoc bodies that start at the newline at i: at the newline after the last. */
function afterHeredocs(cmd, i, delimiters) {
  let at = i;
  for (const d of delimiters) {
    const end = cmd.slice(at + 1).search(new RegExp(`^[ \\t]*${d}[ \\t]*$`, 'm'));
    if (end < 0) return cmd.length;
    at = cmd.indexOf('\n', at + 1 + end);
    if (at < 0) return cmd.length;
  }
  return at;
}
