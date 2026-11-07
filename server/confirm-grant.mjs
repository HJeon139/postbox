// #852 slice 1a: a command the person confirmed runs once, with no second card. It’s the card’s Allow without the
// duplicate: the person read these exact bytes in the confirm’s `commands` field, shown in full outside Markdown, and
// clicked Confirm, as they would have read them on the card and clicked Allow. Packet:
// sprint4/852-s1a-confirm-packet-r2.md (v2), with the person’s answers (24 hours; Ask mode passes).
//
// At the click (blocks.mjs, act): the answer records the SHA-256 of each entry, and the session keeps the confirm in
// its short list of recent ones; then the files each entry names are read and hashed (answer.files). At the call
// (write-intent.mjs, settledCall), a Bash call passes only when every rule below holds; else it gets the card. The
// rule numbers are the packet’s.

import { createHash } from 'node:crypto';
import { splitCommand } from '../shared/command-chains.mjs';
import { commandProblem } from '../shared/confirm-commands.mjs';
import { words } from './adapters/agy-auto.mjs';
import { repoRunsCode } from './git-code-checks.mjs';
import { hashFiles, namedFiles, sameFiles } from './named-files.mjs';
import { pushOf } from './push-on-request.mjs';
import { personAsks } from './write-guard.mjs';

/** How long a confirmed command stays usable once the agent has the answer (rule 6), and once given (rule 7). */
export const CONFIRM_RUN_MS = 15 * 60_000;
export const CONFIRM_ANSWER_MS = 24 * 3_600_000;
/** How many recent confirms a session keeps for this, newest last. */
const RECENT_MAX = 20;
/** Rule 2: a Bash call’s input may carry only these. */
const PLAIN_INPUT = new Set(['command', 'description', 'timeout']);
/** Rule 12: words that change what a later command runs, at a command’s start. */
const SHELL_STATE = new Set(
  'export unset alias unalias source . eval set shopt hash enable builtin declare typeset local readonly trap command_not_found_handle function'.split(' '),
);
/** Rule 12: names whose plain assignment changes a later command. */
const STATE_NAMES = /^(?:PATH|BASH_ENV|ENV|CDPATH|IFS|PS4|PROMPT_COMMAND|GIT_\w*|GH_\w*|SSH_\w*)$/;
const FUNCTION_DEF = /^\s*(?:function\s|[\w.:-]+\s*\(\s*\))/;
const ASSIGNMENT = /^([A-Za-z_]\w*)=/;

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
/** The words of a part after any leading assignments, or null when the reader can’t read it. */
function commandWords(part) {
  const all = words(part);
  if (!all) return null;
  let i = 0;
  while (i < all.length && ASSIGNMENT.test(all[i])) i++;
  return { assigned: all.slice(0, i).map((w) => w.slice(0, w.indexOf('='))), rest: all.slice(i) };
}

/**
 * Rule 10: the folder the command names for itself, `{ folder }` (null when every git and gh part names its own), or
 * null when it doesn’t name its place.
 * @param {string} command @returns {{ folder: string|null } | null}
 */
export function placeOf(command) {
  const parts = splitCommand(command);
  const first = parts.length ? commandWords(parts[0]) : null;
  if (first?.rest[0] === 'cd' && first.rest.length === 2 && first.rest[1].startsWith('/')) return { folder: first.rest[1] };
  for (const part of parts) {
    const w = commandWords(part);
    const [program, ...args] = w?.rest ?? [];
    if (program === 'git' && !(args[0] === '-C' && args[1]?.startsWith('/'))) return null;
    if (program === 'gh' && !args.some((a, i) => a === '--repo' || a === '-R' || a.startsWith('--repo=') || (i > 0 && args[i - 1] === '-R'))) return null;
  }
  return { folder: null };
}

/**
 * Rule 12: whether an earlier Bash call of this turn may have changed what this one runs: shell state, a function, a
 * plain assignment to a name that matters, or anything the reader can’t read fully. Fails closed.
 * @param {any} turn @param {string|null|undefined} toolUseId  this call’s, which ends the earlier ones
 */
export function shellChanged(turn, toolUseId) {
  for (const [id, call] of turn?.seenCalls ?? []) {
    if (id === toolUseId) return false;
    if (call.name !== 'Bash') continue;
    for (const part of splitCommand(String(call.input?.command ?? ''))) {
      const w = commandWords(part);
      if (!w || FUNCTION_DEF.test(part) || SHELL_STATE.has(w.rest[0])) return true;
      if (!w.rest.length && w.assigned.some((name) => STATE_NAMES.test(name))) return true;
    }
  }
  // This call isn’t among the turn’s seen ones: nothing shows what came before it.
  return true;
}

/**
 * At the person’s click on a confirm: what its answer records, and the session’s list of recent confirms. Nothing for
 * a cancel, an answer sent without its revision, or a confirm with no `commands`.
 * @param {any} rt @param {any} it  the block item @param {string} threadId @param {string} action @param {number|undefined} revision
 * @returns {{ commands?: string[] }}
 */
export function recordConfirm(rt, it, threadId, action, revision) {
  const entries = Array.isArray(it.block.commands) ? it.block.commands : [];
  if (it.block.type !== 'confirm' || action !== 'confirm' || revision === undefined || !entries.length) return {};
  const shown = entries.filter((c) => typeof c === 'string' && c && !commandProblem(c));
  const se = rt.s.sessions[it.sessionId];
  if (!shown.length || !se) return {};
  const now = Date.now();
  const recent = (se.confirms ?? []).filter((c) => now - c.at < CONFIRM_ANSWER_MS && c.itemId !== it.id).slice(1 - RECENT_MAX);
  rt.updateSession(se.id, { confirms: [...recent, { threadId, itemId: it.id, at: now }] });
  void recordFiles(rt, threadId, it.id, shown);
  return { commands: shown.map(sha256) };
}

/** After the click: the files each confirmed command names, hashed; a command whose files can’t be read gets none. */
async function recordFiles(rt, threadId, itemId, commands) {
  /** @type {Record<string, { path: string, sha256: string }[]>} */
  const files = {};
  for (const command of commands) {
    const named = namedFiles(command, placeOf(command)?.folder ?? null);
    const hashed = named.ok ? await hashFiles(named.files) : null;
    if (hashed?.ok) files[sha256(command)] = hashed.files;
  }
  const it = rt.store.item(threadId, itemId);
  if (it?.answer?.action === 'confirm' && rt.store.writable) rt.patchItem(threadId, itemId, { answer: { ...it.answer, files } });
}

/** Rule 8: whether anything since the click took the confirm back: the person’s message, or a Stop in this session. */
function revoked(rt, threadId, sessionId, since) {
  const items = rt.store.items(threadId);
  for (let i = items.length - 1; i >= 0 && (items[i].at ?? 0) >= since; i--) {
    const x = items[i];
    if (x.kind === 'user') return true;
    if (x.sessionId === sessionId && x.status === 'stopped' && (x.kind === 'allowedcall' || x.kind === 'agent')) return true;
  }
  return false;
}

/** Rules 3–8 on one confirm: whether it still grants this SHA-256 to this session, now. */
function grants(rt, c, sessionId, hash, now) {
  const it = rt.store.item(c.threadId, c.itemId);
  const answer = it?.answer;
  if (it?.kind !== 'block' || !it.valid || it.block.type !== 'confirm' || it.sessionId !== sessionId) return null;
  if (it.closed || answer?.action !== 'confirm' || answer.revision !== (it.revision ?? 1)) return null;
  const fresh = now - (answer.readAt ?? 0) <= CONFIRM_RUN_MS && now - answer.at <= CONFIRM_ANSWER_MS;
  if (!fresh || !(answer.commands ?? []).includes(hash) || (answer.ran ?? []).includes(hash)) return null;
  if (!answer.files || revoked(rt, c.threadId, sessionId, answer.at)) return null;
  return it;
}

/** Calls being let through now, by `${itemId}:${hash}`: rule 13’s reservation, so two at once can’t both pass. */
const reserving = new Set();

/**
 * A Bash call the person confirmed: `{ threadId, label, blockItemId, sha256, push }` once its fence is marked used and
 * that mark is on disk, or null for a card. A lone push comes back with `push` set, for settledCall’s push path.
 * @param {any} rt @param {string} sessionId @param {{ tool: string, input?: any, agentId?: string|null, bound?: boolean, toolUseId?: string|null }} req
 */
export async function confirmedCall(rt, sessionId, req) {
  const { tool, input, agentId, bound, toolUseId } = req;
  const turn = rt.turns.get(sessionId);
  const se = rt.s.sessions[sessionId];
  const command = input?.command;
  // Rules 1, 2 and 4: a stream-bound Bash call of this session’s own turn, with nothing but the command set.
  if (bound !== true || tool !== 'Bash' || agentId || !turn || turn.remote || !se?.confirms?.length) return null;
  if (typeof command !== 'string' || !command || Object.keys(input).some((k) => !PLAIN_INPUT.has(k))) return null;
  const push = pushOf(command);
  const place = push ? { folder: null } : placeOf(command);
  // Rule 10; and a push only as Postbox makes it (a git push it can’t make itself gets the card).
  if (!place || (!push && splitCommand(command).some((p) => commandWords(p)?.rest.slice(0, 3).includes('push')))) return null;
  if (shellChanged(turn, toolUseId)) return null;
  const hash = sha256(command);
  const now = Date.now();
  const at = se.confirms.map((c) => ({ c, it: grants(rt, c, sessionId, hash, now) })).find((x) => x.it);
  if (!at) return null;
  const key = `${at.it.id}:${hash}`;
  if (reserving.has(key)) return null;
  reserving.add(key);
  try {
    // Rules 9, 11 and 14, which read files.
    if (await personAsks(rt, sessionId, { tool, input })) return null;
    // Rule 11: the same files, by path (a link repointed since the click names another), with the same bytes.
    const recorded = at.it.answer.files[hash];
    const named = namedFiles(command, place.folder);
    const samePaths = named.ok && named.files.length === recorded?.length && named.files.every((f, i) => f === recorded[i].path);
    if (!samePaths || !(await sameFiles(recorded))) return null;
    if (!push && !(await gitIsPlain(command, place.folder))) return null;
    // Rules 3–8 again, since the reads took time; then used, on disk, before the answer.
    const it = grants(rt, at.c, sessionId, hash, Date.now());
    if (!it || rt.turns.get(sessionId) !== turn || !rt.store.writable) return null;
    rt.patchItem(at.c.threadId, it.id, { answer: { ...it.answer, ran: [...(it.answer.ran ?? []), hash] } });
    await rt.store.flush();
    return { threadId: at.c.threadId, label: String(it.block.confirmLabel ?? ''), blockItemId: it.id, sha256: hash, push: push ? command : null };
  } catch {
    return null;
  } finally {
    reserving.delete(key);
  }
}

/** Rule 14: every repository a confirmed git command touches runs none of its own code. */
async function gitIsPlain(command, folder) {
  for (const part of splitCommand(command)) {
    const [program, ...args] = commandWords(part)?.rest ?? [];
    if (program !== 'git') continue;
    const repo = args[0] === '-C' ? args[1] : folder;
    if (!repo || !(await repoRunsCode(repo)).ok) return false;
  }
  return true;
}

/**
 * settledCall’s found for a command the person confirmed, or null for a card: a lone push is made by Postbox, as one
 * the person asked for is (#296, #562), so its consequence is read here; `pushes` is write-intent.mjs’s.
 * @param {any} rt @param {string} sessionId @param {any} req @param {{ consequence: Function }} pushes
 */
export async function confirmedFound(rt, sessionId, req, pushes) {
  const c = await confirmedCall(rt, sessionId, req);
  if (!c) return null;
  const found = { threadId: c.threadId, how: /** @type {const} */ ('confirmed'), label: c.label, blockItemId: c.blockItemId, sha256: c.sha256 };
  if (!c.push) return found;
  const { folder, project } = await rt.panelTarget({ sessionId });
  // The branch the push names counts as named, as a request’s words do (push-on-request.mjs, tokensOf).
  const named = c.push.toLowerCase();
  const push = await (rt.pushes ?? pushes).consequence({ folder, url: project?.pushUrl, push: pushOf(c.push), named });
  return push ? { ...found, push } : null;
}
