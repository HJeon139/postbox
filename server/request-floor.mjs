// What a request may ever let through without a card (#296), decided in code before any model reads the call. It’s an
// allow-list: a call passes only when each part of it is something listed here, and everything else gets the card,
// whatever the person asked. A list of what to block can’t be the floor. The review of #557 found a force push by
// refspec, deletes by short flag, API deletes, a shell inside a string and aliases, all past a blocklist.
// - a command: each part a gh create, comment or edit within #296’s limits, a command that only reads files in the
//   project, or a quoted here-document for a body; no redirect, and no VAR=value, which can run code. Never git: a
//   push or a commit does what the repository’s config, hooks and remotes say, which the agent can change with calls
//   Postbox never sees, so four rounds of review found a way past every list of what to check (#557, #562);
// - an MCP tool: one whose name creates, adds, edits, updates, comments, posts, appends, replies or writes, never one
//   that also deletes, merges or closes, or touches labels, reviews, files or settings, and only with its input there
//   to judge, each field one the same limits allow: text, a PR’s branches, a repository or an item the person named.

import { splitCommand } from '../shared/permission-match.mjs';
import { inProject, isText, namesRepo, shellWords, tokensOf } from './request-words.mjs';

export { shellWords };

// A branch a PR names: never another owner’s (attacker:evil), a src:dst refspec, or a ref expression.
const PLAIN_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

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

// Flags whose value is text the agent wrote, never words that tie the person’s quote to the call.
const TEXT_FLAGS = new Set([...TITLE, ...BODY, '-m', '--message', '-am']);

/** The number a PR or an issue goes by, from its number or its link. */
export const numberOf = (target) => /^#?(\d+)$/.exec(target)?.[1] ?? /\/(?:pull|issues)\/(\d+)\/?$/.exec(target)?.[1] ?? null;

/**
 * Whether the person named an item, or this conversation made it: by its link, or by its number as #12, “issue 12”,
 * “PR 12” or “ticket 12”. A number this conversation made counts only on the project’s own repository.
 * @param {string} target @param {Scope} scope @param {boolean} elsewhere  on a repository the person named
 */
function itemOnRequest(target, scope, elsewhere) {
  if (/^https?:/.test(target)) return scope.made.urls.includes(target) || tokensOf(scope.named).has(target.toLowerCase().replace(/\/$/, ''));
  const n = numberOf(target);
  if (!n) return false;
  // lint-allow regex: n is digits only.
  const named = new RegExp(`(?:^|[^\\w])#${n}\\b|\\b(?:issue|pr|pull request|ticket)\\s+#?${n}\\b`).test(scope.named);
  return named || (!elsewhere && scope.made.numbers.includes(n));
}

/**
 * Whether a gh flag’s value is one a request may cover: a title or a body as text (isText), a body file in the
 * project and never stdin, and a PR’s branches as plain refs, never another owner’s (attacker:evil).
 * @param {string} flag @param {string} v @param {Scope} scope
 */
function flagValueOk(flag, v, scope) {
  if (flag === '--body-file' || flag === '-F') return v !== '-' && inProject(v, scope.folder);
  if ([...TITLE, '--body', '-b'].includes(flag)) return isText(v);
  if (['--head', '-H', '--base', '-B'].includes(flag)) return PLAIN_REF.test(v);
  return true;
}

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
      if (v === undefined || !flagValueOk(flag, v, scope)) return false;
      if (REPO.includes(flag)) repo = v;
    } else return false;
  }
  if (targets.length !== (rule.target ? 1 : 0)) return false;
  if (repo && !namesRepo(tokensOf(scope.named), repo)) return false;
  const [target] = targets;
  return !target || itemOnRequest(target, scope, Boolean(repo));
}

// Commands that only read and print, on files in the project; a redirect, a pipe into a shell or a VAR=value still
// asks. Not rg, whose --pre runs a program, nor date, which can set the clock; tail only without following.
const READS = new Set(['echo', 'cat', 'ls', 'pwd', 'which', 'head', 'tail', 'wc', 'grep', 'true']);

/**
 * What a request’s floor reads beside the call: the words the person typed or confirmed (lowercase), the PRs and
 * issues this conversation created, from the work ledger, and the agent’s folder, to follow links from.
 * @typedef {{ named: string, made: { urls: string[], numbers: string[] }, folder?: string|null }} Scope
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
  if (program === 'gh') return ghOnRequest(rest, scope);
  if (program === 'tail' && rest.some((w) => /^-[a-zA-Z]*[fF]|^--follow/.test(w))) return false;
  return READS.has(program) && rest.every((w) => inProject(w, scope.folder));
}

// The verbs an MCP tool’s name may carry to pass, and the words that keep it off whatever else it says: a take-away,
// or something #296 never lets a request touch (labels, reviews, files, branches, settings, people).
const MCP_VERBS = /^(?:create|add|update|edit|comment|post|append|reply|write|insert)$/;
const MCP_TAKES =
  /^(?:delete|remove|destroy|drop|purge|merge|close|archive|trash|revoke|transfer|wipe|erase|move|rename|share|invite|set|lock|labels?|reviews?|reviewers?|approve|assignees?|milestone|collaborators?|members?|permissions?|repo|repository|file|files|branch|workflow|secrets?|webhook|fork|gists?|visibility|key|token)$/;

// The fields an MCP call may carry, and what each may hold: text the agent writes, a PR’s branches, a draft, the
// repository (one the person named) and the item (one they named or this conversation made). Any other field gets
// the card: a state, labels, an event, a path, a visibility.
const MCP_TEXT = new Set(['title', 'body', 'text', 'content', 'description', 'comment', 'message', 'summary', 'subject']);
const MCP_ITEM = new Set(['number', 'issue_number', 'pull_number', 'pr_number', 'issue', 'ticket', 'ticket_id', 'id']);
const snake = (k) => k.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();

/**
 * Whether every field of an MCP call’s input is one a request may cover (above). A PR’s branches only as it’s created:
 * an update’s base retargets the PR.
 * @param {any} input @param {Scope} scope @param {boolean} creates
 */
function fieldsOnRequest(input, scope, creates) {
  const { owner, repo: name } = input;
  if (owner !== undefined && (typeof owner !== 'string' || typeof name !== 'string')) return false;
  let elsewhere = false;
  for (const [k, v] of Object.entries(input)) {
    const key = snake(k);
    if (MCP_TEXT.has(key) ? typeof v === 'string' : key === 'draft' ? typeof v === 'boolean' : key === 'owner') continue;
    if (key === 'head' || key === 'base') {
      if (!creates || typeof v !== 'string' || !PLAIN_REF.test(v)) return false;
    } else if (key === 'repo' || key === 'repository') {
      const full = typeof owner === 'string' ? `${owner}/${v}` : String(v);
      if (typeof v !== 'string' || !namesRepo(tokensOf(scope.named), full)) return false;
      elsewhere = true;
    } else if (!MCP_ITEM.has(key) || !['string', 'number'].includes(typeof v)) return false;
  }
  // The item last, once the repository it’s on is known.
  return Object.entries(input).every(([k, v]) => !MCP_ITEM.has(snake(k)) || itemOnRequest(String(v), scope, elsewhere));
}

/**
 * A call’s own words, without the text the agent wrote in it (a title, a body, a message): what the person’s quote
 * must share a word with, so “looks good” can’t tie to a comment whose body says it.
 * @param {string} tool @param {any} input
 */
export function actionWords(tool, input) {
  if (tool !== 'Bash') {
    const fields = Object.entries(input ?? {}).filter(([k, v]) => !MCP_TEXT.has(snake(k)) && typeof v !== 'object');
    return [String(tool).replace(/[_./-]+/g, ' '), ...fields.map(([, v]) => String(v))].join(' ');
  }
  const out = [];
  for (const part of splitCommand(String(input?.command ?? ''))) {
    if (part.startsWith('cat <<')) continue;
    const words = shellWords(part);
    for (let i = 0; i < words.length; i++) {
      const eq = words[i].startsWith('--') ? words[i].indexOf('=') : -1;
      if (TEXT_FLAGS.has(words[i])) i++;
      else if (!(eq > 0 && TEXT_FLAGS.has(words[i].slice(0, eq)))) out.push(words[i]);
    }
  }
  return out.join(' ');
}

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
  if (words.some((w) => MCP_TAKES.test(w))) return 'it takes something away, or touches what a request never does';
  if (!words.some((w) => MCP_VERBS.test(w))) return 'its name doesn’t create, add, edit or comment';
  return fieldsOnRequest(input, scope, words.includes('create')) ? null : 'it carries a field a request can’t cover';
}
