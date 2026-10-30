// Writes outside Postbox the person already approved in a block (#296). In one room, every push the person approved
// in a confirm or a review then waited on a permission card for the same call, at least seven times in three days, and
// Always allow didn’t help: each gh pr create had its own title. Now a turn that an approved block started may make
// the gh writes that block names without a card. Postbox decides that here, in code, never a model:
// - only creating, commenting on and editing PRs and issues, never merging, closing, labels, reviewers or releases;
// - only on the project’s own repository, unless the block names the repository;
// - a create only when the block names its title, and a comment or an edit only on an item the block names or this
//   conversation made;
// - a command of nothing but those calls (and a quoted here-document for a body), so nothing else rides along;
// - at most APPROVED_WRITES_MAX writes, and none after the person stops them on the line each write leaves.
// Anything else gets the card, as before.

import { splitCommand } from '../shared/permission-match.mjs';
import { setupOf } from './adapters/setup.mjs';
import { clip, httpError } from './helpers.mjs';
import { writeCalls, writePasses } from './write-guard.mjs';

/** Writes one approval lets through before the card comes back. */
export const APPROVED_WRITES_MAX = 5;

const TITLE = ['--title', '-t'];
const BODY = ['--body', '-b', '--body-file', '-F'];
const REPO = ['--repo', '-R'];
// The gh writes an approval can cover, with the flags each may carry. A flag left out (a label, a reviewer, an
// assignee, a milestone, --delete-last) gets the card.
const COVERED = {
  'pr create': { flags: [...TITLE, ...BODY, ...REPO, '--base', '-B', '--head', '-H'], bool: ['--draft', '-d'], target: false },
  'issue create': { flags: [...TITLE, ...BODY, ...REPO], bool: [], target: false },
  'pr comment': { flags: [...BODY, ...REPO], bool: ['--edit-last'], target: true },
  'issue comment': { flags: [...BODY, ...REPO], bool: ['--edit-last'], target: true },
  'pr edit': { flags: [...TITLE, ...BODY, ...REPO], bool: [], target: true },
  'issue edit': { flags: [...TITLE, ...BODY, ...REPO], bool: [], target: true },
};
// A title shorter than this could turn up in any block by chance.
const MIN_TITLE = 12;
// The body text Claude Code passes as --body "$(cat <<'EOF' … EOF)": a quoted delimiter, so nothing in it runs.
const HEREDOC = /^cat <<-?'([A-Za-z_]+)'\n[\s\S]*\n\1$/;

/**
 * A command’s words as the shell would split them, with quotes removed. Nothing is expanded: a $( ) stays text, and
 * the command it holds is a part of its own (splitCommand), which must pass on its own.
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
 * A gh write as its parts, or null when it isn’t one an approval can cover: its subcommand, its flags’ values, and
 * the item it names.
 * @param {string} part @returns {{ what: string, values: Record<string, string>, target: string|null } | null}
 */
export function ghCall(part) {
  const [gh, noun, verb, ...rest] = shellWords(part);
  const what = `${noun} ${verb}`;
  const rule = gh === 'gh' && Object.hasOwn(COVERED, what) ? COVERED[what] : null;
  if (!rule) return null;
  /** @type {Record<string, string>} */
  const values = {};
  const targets = [];
  for (let i = 0; i < rest.length; i++) {
    // --title=X is --title X.
    const eq = rest[i].startsWith('--') ? rest[i].indexOf('=') : -1;
    const [flag, inline] = eq > 0 ? [rest[i].slice(0, eq), rest[i].slice(eq + 1)] : [rest[i], null];
    if (!flag.startsWith('-')) targets.push(flag);
    else if (rule.bool.includes(flag) && inline === null) continue;
    else if (rule.flags.includes(flag)) {
      const v = inline ?? rest[++i];
      if (v === undefined) return null;
      values[TITLE.includes(flag) ? 'title' : REPO.includes(flag) ? 'repo' : flag] = v;
    } else return null;
  }
  if (targets.length !== (rule.target ? 1 : 0)) return null;
  return { what: `gh ${what}`, values, target: targets[0] ?? null };
}

const norm = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

/** The number a PR or an issue goes by, from its number or its link. */
const numberOf = (target) => /^#?(\d+)$/.exec(target)?.[1] ?? /\/(?:pull|issues)\/(\d+)\/?$/.exec(target)?.[1] ?? null;

/**
 * Whether the approved words cover a gh write (see the top of this file).
 * @param {NonNullable<ReturnType<typeof ghCall>>} call @param {string} words  the block’s text
 * @param {{ urls: string[], numbers: string[] }} made  the PRs and issues this conversation created
 */
export function covers(call, words, made) {
  const w = norm(words);
  if (call.values.repo && !w.includes(norm(call.values.repo))) return false;
  if (!call.target) return norm(call.values.title).length >= MIN_TITLE && w.includes(norm(call.values.title));
  // A link names its repository; a number is on the project’s, or on the one --repo named. A branch gets the card.
  if (/^https?:/.test(call.target)) return made.urls.includes(call.target) || w.includes(norm(call.target));
  const n = numberOf(call.target);
  if (!n) return false;
  // lint-allow regex: n is digits only.
  return new RegExp(`(?:^|[^\\w])#${n}\\b`).test(w) || (!call.values.repo && made.numbers.includes(n));
}

/** What the person saw and approved in a confirm or a review block, as one text. */
const wordsOf = (b) =>
  [b.title, b.statement, b.confirmLabel, b.type === 'review' && b.format !== 'app' ? b.content : ''].filter((x) => typeof x === 'string').join('\n');

/**
 * The approved block whose answer started this turn: a confirm confirmed, or a review approved, at the revision the
 * turn was given. Null for a turn anything else started.
 * @param {any} rt @param {any} turn
 */
export function approvalOf(rt, turn) {
  const asked = turn?.asked;
  const threadId = asked?.threadId ?? rt.s.sessions[turn?.sessionId]?.threadId;
  for (const m of asked?.message?.messages ?? (asked?.message ? [asked.message] : [])) {
    if (m?.kind !== 'event' || !m.blockItemId) continue;
    const it = rt.store.item(threadId, m.blockItemId);
    const a = it?.kind === 'block' && it.valid && it.sessionId === turn.sessionId ? it.answer : null;
    if (!a || (m.event?.revision !== undefined && a.revision !== m.event.revision)) continue;
    const yes = it.block.type === 'confirm' ? a.action === 'confirm' : it.block.type === 'review' && a.values?.verdict === 'approve';
    if (yes) return { threadId, item: it, words: wordsOf(it.block) };
  }
  return null;
}

/** The PRs and issues this conversation created, from the work ledger (#132). */
function madeBy(rt, turn, threadId) {
  const urls = (rt.s.work?.[turn.work?.convId ?? threadId] ?? [])
    .filter((e) => e.kind === 'external' && e.via === 'gh' && /^gh (pr|issue) create$/.test(e.what) && e.state === 'done')
    .flatMap((e) => e.urls ?? []);
  return { urls, numbers: urls.map(numberOf).filter(Boolean) };
}

/**
 * The approval that covers this call, with the gh writes it makes, or null for the card (see the top of this file).
 * @param {any} rt @param {string} sessionId @param {{ tool: string, input?: any }} req
 * @returns {{ approval: NonNullable<ReturnType<typeof approvalOf>>, calls: string[] } | null}
 */
export function approvedWrite(rt, sessionId, { tool, input }) {
  const se = rt.s.sessions[sessionId];
  const turn = rt.turns.get(sessionId);
  // A host’s turn asks through its host (#120), and MCP writes are for the judge #296 describes, still to come.
  if (!se || !turn || turn.remote || tool !== 'Bash' || !setupOf(rt.personaFor(se)).writesAsApproved) return null;
  const approval = approvalOf(rt, turn);
  const calls = writeCalls(tool, input).map((c) => String(c.arg));
  if (!approval || !calls.length) return null;
  const lines = rt.store.items(approval.threadId).filter((x) => x.kind === 'allowedwrite' && x.blockItemId === approval.item.id);
  if (lines.some((x) => x.status === 'stopped') || lines.reduce((n, x) => n + (x.calls ?? 1), 0) + calls.length > APPROVED_WRITES_MAX) return null;
  const made = madeBy(rt, turn, approval.threadId);
  for (const part of splitCommand(String(input?.command ?? ''))) {
    const call = calls.includes(part) ? ghCall(part) : null;
    if (call ? !covers(call, approval.words, made) : !HEREDOC.test(part)) return null;
  }
  return { approval, calls };
}

/**
 * A write outside Postbox the person already settled, so it runs without a card: by a rule or the persona’s setup
 * (write-guard.mjs, writePasses), or by the block that started this turn, with a line that says so. Null for a card.
 * @param {any} rt @param {string} sessionId @param {{ tool: string, input?: any }} req
 * @returns {Promise<{ allow: boolean } | null>}
 */
export async function settledWrite(rt, sessionId, req) {
  if (await writePasses(rt, sessionId, req).catch(() => false)) return { allow: true };
  /** @type {ReturnType<typeof approvedWrite>} */
  let approved = null;
  try {
    approved = approvedWrite(rt, sessionId, req);
  } catch {
    // A check that breaks gets the card, as before: it fails closed.
  }
  return approved ? allowApproved(rt, sessionId, approved) : null;
}

/**
 * Lets an approved write run, and says so in the conversation, with a way to stop the rest.
 * @param {any} rt @param {string} sessionId @param {NonNullable<ReturnType<typeof approvedWrite>>} approved
 */
export function allowApproved(rt, sessionId, { approval, calls }) {
  const se = rt.s.sessions[sessionId];
  const turn = rt.turns.get(sessionId);
  const b = approval.item.block;
  rt.addItem(approval.threadId, {
    kind: 'allowedwrite',
    sessionId,
    handle: se.handle,
    turnId: turn?.id ?? null,
    blockItemId: approval.item.id,
    what: [...new Set(calls.map((c) => ghCall(c)?.what ?? 'gh'))].join(', '),
    command: clip(calls.join('\n'), 2000),
    calls: calls.length,
    // What the person approved, in the block’s own words.
    approved: clip(b.type === 'confirm' ? b.confirmLabel : (b.title ?? 'the draft'), 200),
    verb: b.type === 'confirm' ? 'confirmed' : 'approved',
    status: 'allowed',
  });
  return { allow: true };
}

/**
 * Stop on an allowed write’s line: the approval lets nothing more through, and the agent’s next write gets a card.
 * @param {any} rt @param {string} threadId @param {string} itemId @param {string} action
 */
export function stopApproved(rt, threadId, itemId, action) {
  const it = rt.store.item(threadId, itemId);
  if (action !== 'stop') throw httpError(422, 'An allowed write only takes “stop”.');
  if (it.status === 'stopped') return { ok: true };
  for (const x of rt.store.items(threadId))
    if (x.kind === 'allowedwrite' && x.blockItemId === it.blockItemId && x.status !== 'stopped') rt.patchItem(threadId, x.id, { status: 'stopped' });
  rt.addItem(threadId, { kind: 'voice', text: `Stopped: @${it.handle}’s next write outside Postbox asks you first` });
  return { ok: true };
}
