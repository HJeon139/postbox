// What a request may ever let through without a card (#296), decided in code before any model reads the call. It’s an
// allow-list: a call passes only when each part of it is something listed here, and everything else gets the card,
// whatever the person asked. A list of what to block can’t be the floor. The review of #557 found a force push by
// refspec, deletes by short flag, API deletes, a shell inside a string and aliases, all past a blocklist.
// - a command: each part a plain git command or push, a gh create, comment or edit within #296’s limits, a command
//   that only reads, or a quoted here-document for a body; no redirect, and no VAR=value, which can run code;
// - an MCP tool: one whose name creates, adds, edits, updates, comments, posts, appends, replies or writes, never one
//   that also deletes, removes, merges or closes, and only with its input there to judge.

import { splitCommand } from '../shared/permission-match.mjs';

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

// Flags that take something away, wherever they appear.
const FORCE = /^(?:--force(?:-with-lease)?(?:=.*)?|-f|--hard|--delete|-d|-D|--prune|--mirror|-rf|-fr)$/;

// git subcommands a request may cover, each with the flags it may carry; null takes any flag but FORCE. Anything else
// gets the card: a delete or a rewrite (tag -d, branch -D, update-ref -d, checkout -- ., restore, reset), an alias,
// or a global option before the subcommand (-c alias.p=push, -C).
const GIT = {
  status: null,
  log: null,
  diff: null,
  show: null,
  add: null,
  commit: null,
  fetch: ['-q', '--quiet', '--all', '--tags'],
  push: ['-u', '--set-upstream', '-q', '--quiet', '-v', '--verbose'],
};
// A ref a plain push names: a remote or a branch, never a +force, a src:dst or :delete refspec, or a ref expression.
const PLAIN_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/**
 * Whether a git command is one a request may cover: a push only as git push [remote] [branch], -u, -q or -v.
 * @param {string[]} args  the words after git
 */
function gitOnRequest(args) {
  const [sub, ...rest] = args;
  const flags = sub && Object.hasOwn(GIT, sub) ? GIT[sub] : undefined;
  if (flags === undefined) return false;
  if (flags === null) return !rest.some((w) => FORCE.test(w));
  if (rest.some((w) => w.startsWith('-') && !flags.includes(w))) return false;
  const refs = rest.filter((w) => !w.startsWith('-'));
  return sub !== 'push' || (refs.length <= 2 && refs.every((w) => PLAIN_REF.test(w)));
}

const TITLE = ['--title', '-t'];
const BODY = ['--body', '-b', '--body-file', '-F'];
const REPO = ['--repo', '-R'];
// The gh writes a request can cover, with the flags each may carry (#296: never labels, reviewers, assignees,
// milestones, projects, locks, settings, secrets or the API).
const GH = {
  'pr create': { flags: [...TITLE, ...BODY, ...REPO, '--base', '-B', '--head', '-H'], bool: ['--draft', '-d'], target: false },
  'issue create': { flags: [...TITLE, ...BODY, ...REPO], bool: [], target: false },
  'pr comment': { flags: [...BODY, ...REPO], bool: ['--edit-last'], target: true },
  'issue comment': { flags: [...BODY, ...REPO], bool: ['--edit-last'], target: true },
  'pr edit': { flags: [...TITLE, ...BODY, ...REPO], bool: [], target: true },
  'issue edit': { flags: [...TITLE, ...BODY, ...REPO], bool: [], target: true },
};

/** The number a PR or an issue goes by, from its number or its link. */
export const numberOf = (target) => /^#?(\d+)$/.exec(target)?.[1] ?? /\/(?:pull|issues)\/(\d+)\/?$/.exec(target)?.[1] ?? null;

/**
 * Whether a gh write is one a request may cover (#296): on the project’s own repository, or one the person named; a
 * comment or an edit only on an item this conversation made or the person named, by its number or its link.
 * @param {string[]} args  the words after gh @param {Scope} scope
 */
function ghOnRequest(args, scope) {
  const [noun, verb, ...rest] = args;
  const rule = Object.hasOwn(GH, `${noun} ${verb}`) ? GH[`${noun} ${verb}`] : null;
  if (!rule) return false;
  /** @type {string|null} */
  let repo = null;
  const targets = [];
  for (let i = 0; i < rest.length; i++) {
    // --title=X is --title X.
    const eq = rest[i].startsWith('--') ? rest[i].indexOf('=') : -1;
    const [flag, inline] = eq > 0 ? [rest[i].slice(0, eq), rest[i].slice(eq + 1)] : [rest[i], null];
    if (!flag.startsWith('-')) targets.push(flag);
    else if (rule.bool.includes(flag) && inline === null) continue;
    else if (rule.flags.includes(flag)) {
      const v = inline ?? rest[++i];
      if (v === undefined) return false;
      if (REPO.includes(flag)) repo = v;
    } else return false;
  }
  if (targets.length !== (rule.target ? 1 : 0)) return false;
  if (repo && !scope.named.includes(repo.toLowerCase())) return false;
  const [target] = targets;
  if (!target) return true;
  if (/^https?:/.test(target)) return scope.made.urls.includes(target) || scope.named.includes(target.toLowerCase());
  const n = numberOf(target);
  if (!n) return false;
  // lint-allow regex: n is digits only.
  return new RegExp(`(?:^|[^\\w])#${n}\\b`).test(scope.named) || (!repo && scope.made.numbers.includes(n));
}

// Commands that only read and print, with any arguments; a redirect, a pipe into a shell or a VAR=value still asks.
const READS = new Set(['echo', 'cat', 'ls', 'pwd', 'which', 'head', 'tail', 'wc', 'grep', 'rg', 'date', 'true']);

/**
 * What a request’s floor reads beside the call: the words the person typed or confirmed (lowercase), and the PRs and
 * issues this conversation created, from the work ledger.
 * @typedef {{ named: string, made: { urls: string[], numbers: string[] } }} Scope
 */

/** Whether one part of a command is on the allow-list. */
function partOnRequest(part, scope) {
  // A quoted here-document is text, as the body Claude Code passes to --body "$(cat <<'EOF' … EOF)".
  if (/^cat <<-?'([A-Za-z_]+)'\n[\s\S]*\n\1$/.test(part)) return true;
  const words = shellWords(part);
  // A redirect is a < or > outside quotes: inside them it’s text, such as a body’s $(cat <<'EOF' …).
  const unquoted = part.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, '');
  if (!words.length || /^[A-Za-z_]\w*=/.test(words[0]) || /[<>]/.test(unquoted)) return false;
  const [program, ...rest] = words;
  if (program === 'git') return gitOnRequest(rest);
  if (program === 'gh') return ghOnRequest(rest, scope);
  return READS.has(program);
}

// The verbs an MCP tool’s name may carry to pass, and the words that keep it off whatever else it says.
const MCP_VERBS = /^(?:create|add|update|edit|comment|post|append|reply|write|insert)$/;
const MCP_TAKES = /^(?:delete|remove|destroy|drop|purge|merge|close|archive|trash|revoke|transfer|wipe|erase|move|rename|share|invite|set|lock)$/;

/**
 * Why a request can’t cover this call, whatever the person said, or null when it may (see the top of this file).
 * @param {string} tool @param {any} input @param {Scope} scope @returns {string|null}
 */
export function offRequest(tool, input, scope) {
  const name = String(tool ?? '');
  if (name === 'Bash') {
    const parts = splitCommand(String(input?.command ?? ''));
    return parts.length && parts.every((p) => partOnRequest(p, scope)) ? null : 'it isn’t a command a request can cover';
  }
  if (!name.startsWith('mcp__')) return 'only commands and MCP tools can be covered';
  // Codex asks about an MCP call without its arguments: with nothing to judge, it’s a card.
  if (!input || typeof input !== 'object' || !Object.keys(input).length) return 'its input isn’t there to judge';
  const words = name
    .replace(/^mcp__.+?__/, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[\s_\-.]+/);
  if (words.some((w) => MCP_TAKES.test(w))) return 'it deletes, removes, merges, closes or moves';
  return words.some((w) => MCP_VERBS.test(w)) ? null : 'its name doesn’t create, add, edit or comment';
}
