// #852 slice 1a: a command the person confirmed runs once, byte for byte, in the same agent’s session, with no second
// card. It’s the card’s Allow without the duplicate: the person read these exact bytes on the confirm and clicked
// Confirm, as they would have read them on the card and clicked Allow. Nothing wider: the call must still be one the
// turn’s stream showed (prompt-claim.mjs), and the harness decides first, so a call it refuses never reaches here.
//
// At the click (blocks.mjs, act), the answer records the SHA-256 of each fenced block in the statement that shows as
// its bytes, and the session keeps the confirm in its short list of recent ones. At the call (write-intent.mjs,
// settledCall), a Bash call passes when its command’s SHA-256 is one of those, within the limits below, and that fence
// hasn’t let a call through: it’s marked on the answer, and an allowed-call line is written, before the call runs.
// Packet: sprint4/852-s1a-confirm-packet-r1.md, with the person’s answers.

import { createHash } from 'node:crypto';
import { clip } from './helpers.mjs';

/** How long a confirmed command stays usable once the agent has the answer, and once the person gave it. */
export const CONFIRM_RUN_MS = 15 * 60_000;
export const CONFIRM_ANSWER_MS = 24 * 3_600_000;
/** How many recent confirms a session keeps for this, newest last. */
const RECENT_MAX = 20;

// Characters that show differently from their bytes, or not at all: controls other than tab and newline (a carriage
// return and ANSI escapes among them), zero-width characters and marks, bidi embeddings, overrides and isolates
// (Trojan Source), and the byte-order mark. A fence holding one grants nothing.
// biome-ignore lint/suspicious/noControlCharactersInRegex: these are the characters it looks for.
const HIDDEN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/u;

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/** Each fenced block’s content in a statement, exactly as written: only the newline before its closing fence goes. */
export function fencedCommands(statement) {
  return [...String(statement ?? '').matchAll(/^```[^\n]*\n([\s\S]*?)\n```[ \t]*$/gm)].map((m) => m[1]);
}

/** The SHA-256 of each fenced command that shows as its bytes. Inline code never counts. */
export function shownCommands(statement) {
  return fencedCommands(statement)
    .filter((command) => !HIDDEN.test(command))
    .map(sha256);
}

/**
 * At the person’s click on a confirm: the fields its answer adds, and the session’s list of recent confirms, which is
 * how a later call finds it without reading the room. Nothing for a cancel, or a confirm with no fenced command.
 * @param {any} rt @param {any} it  the block item @param {string} threadId @param {string} action
 * @returns {{ commands?: string[] }}
 */
export function recordConfirm(rt, it, threadId, action) {
  if (it.block.type !== 'confirm' || action !== 'confirm') return {};
  const commands = shownCommands(it.block.statement);
  const se = rt.s.sessions[it.sessionId];
  if (!commands.length || !se) return {};
  const now = Date.now();
  const recent = (se.confirms ?? []).filter((c) => now - c.at < CONFIRM_ANSWER_MS && c.itemId !== it.id).slice(1 - RECENT_MAX);
  rt.updateSession(se.id, { confirms: [...recent, { threadId, itemId: it.id, at: now }] });
  return { commands };
}

/** Whether this confirm still lets a call with this SHA-256 run, now, for this session. */
function grants(it, sessionId, hash, now) {
  const answer = it?.answer;
  if (it?.kind !== 'block' || !it.valid || it.block.type !== 'confirm' || it.sessionId !== sessionId) return false;
  if (it.closed || answer?.action !== 'confirm' || answer.revision !== (it.revision ?? 1)) return false;
  const fresh = now - (answer.readAt ?? 0) <= CONFIRM_RUN_MS && now - answer.at <= CONFIRM_ANSWER_MS;
  return fresh && (answer.commands ?? []).includes(hash) && !(answer.ran ?? []).includes(hash);
}

/**
 * A Bash call the person confirmed: marks its fence as used and writes the allowed-call line, then says it passes.
 * False for a card: not Bash, a subagent’s or a host turn’s call, no confirm that grants it, or a store that can’t
 * record it, since nothing runs unrecorded. O(k) in the session’s recent confirms, each one item lookup.
 * @param {any} rt @param {string} sessionId @param {{ tool: string, summary?: string, input?: any, agentId?: string|null }} req
 */
export function passConfirmed(rt, sessionId, { tool, summary, input, agentId }) {
  const turn = rt.turns.get(sessionId);
  const se = rt.s.sessions[sessionId];
  const command = input?.command;
  if (tool !== 'Bash' || agentId || !turn || turn.remote || !se?.confirms?.length || typeof command !== 'string') return false;
  if (!rt.store.writable) return false;
  const hash = sha256(command);
  const now = Date.now();
  const found = se.confirms.map((c) => ({ threadId: c.threadId, it: rt.store.item(c.threadId, c.itemId) })).find((c) => grants(c.it, sessionId, hash, now));
  if (!found) return false;
  const { threadId, it } = found;
  rt.patchItem(threadId, it.id, { answer: { ...it.answer, ran: [...(it.answer.ran ?? []), hash] } });
  rt.addItem(threadId, {
    kind: 'allowedcall',
    sessionId,
    handle: se.handle,
    turnId: turn.id,
    tool: 'Bash',
    summary: clip(String(summary ?? tool), 200),
    // The whole command, as the person confirmed it: a statement is at most 2,000 characters.
    detail: command,
    how: 'confirmed',
    approved: clip(String(it.block.confirmLabel ?? ''), 200),
    blockItemId: it.id,
    sha256: hash,
    status: 'allowed',
  });
  return true;
}
