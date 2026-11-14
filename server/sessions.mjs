// The writes of a session that exists: its changed fields as a session.patch (server/session-patch.mjs), and the
// Postbox notices it reads at the start of its next turn. Each starts from the session as memory will hold it once what
// is held behind a commit is released (store.pending.session), as a thread write does (#796, server/threads.mjs):
// diffed against the published session, a change back to its published value was dropped behind a held change, and a
// notice appended to the published context dropped the one before it. A field built from the session's own is built
// in a function of the pending session; tests/session-write-guard.test.mjs places those still built from a published one.

import { itemOf } from '../shared/item-index.mjs';
import { clipText, httpError } from './helpers.mjs';
import { sessionPatch } from './session-patch.mjs';
import { newId } from './store.mjs';
import { liftDecline } from './wake-cards.mjs';

/**
 * Writes the fields of `change` that change the session, with updatedAt. `change` is the fields to set, or a function
 * of the pending session that returns them, so a field built from the session's own (its context, its backend state)
 * starts from what a held write left. A session that doesn’t exist isn’t written.
 * @param {import('./runtime.mjs').Runtime} rt @param {string} id
 * @param {Record<string, unknown> | ((se: any) => Record<string, unknown>)} change
 */
export function updateSession(rt, id, change) {
  const se = rt.store.pending.session(id);
  if (!se) return;
  const patch = typeof change === 'function' ? change(se) : change;
  rt.store.emit('session.patch', sessionPatch(se, { ...patch, ...needAt(rt, se, patch), updatedAt: Date.now() }));
}

/**
 * With a new need, the time its item was posted, as needsAt (#1155): ⌃J orders by it (shared/needs.mjs, waitedSince),
 * and the page holds no items of a conversation it hasn't opened. It names the need's item, so a need written another
 * way isn't given another's time; a cleared need clears it. Read pending, as the item may have been added behind a commit.
 * @param {import('./runtime.mjs').Runtime} rt @param {any} se @param {Record<string, any>} patch
 */
function needAt(rt, se, patch) {
  if (!Object.hasOwn(patch, 'needs')) return {};
  const need = patch.needs;
  const where = need?.threadId ?? (patch.sideTurn ?? se.sideTurn)?.threadId ?? se.threadId;
  const at = need?.itemId ? itemOf(rt.store.pending.items(where), need.itemId)?.at : undefined;
  return { needsAt: at === undefined ? undefined : { itemId: need.itemId, at } };
}

/**
 * Every session that needs you from before needsAt, given its need's item time once, as the store loads (#1155): the
 * page orders ⌃J by it and holds no items of a conversation it hasn't opened. A need whose item is gone gets none, and
 * waitedSince falls back to the session's last change, as before. @param {import('./runtime.mjs').Runtime} rt
 */
export function stampNeeds(rt) {
  for (const id of Object.keys(rt.s.sessions)) {
    const se = rt.store.pending.session(id);
    if (!se?.needs?.itemId || se.needsAt?.itemId === se.needs.itemId) continue;
    const { needsAt } = needAt(rt, se, { needs: se.needs });
    if (needsAt) rt.store.emit('session.patch', sessionPatch(se, { needsAt }));
  }
}

/** Context the agent reads at the start of its next turn, as a Postbox notice. @param {import('./runtime.mjs').Runtime} rt @param {string} sessionId @param {string} text */
export function tellAgent(rt, sessionId, text) {
  rt.updateSession(sessionId, (se) => ({ context: [...(se.context ?? []), `[Postbox] ${text}`].slice(-20) }));
}

/**
 * A thread's sessions as memory will hold them once what is held is released, as sessionsIn reads the published ones:
 * for a read that decides whether to make a session. One made behind a held commit is only pending, so a second
 * @-mention of the same new agent in that window made a second session, and one persona answered from two (intent.md:
 * one session per persona per conversation).
 * @param {import('./runtime.mjs').Runtime} rt @param {string} threadId @returns {any[]}
 */
export function pendingSessionsIn(rt, threadId) {
  const { members = [] } = rt.store.pending.thread(threadId) ?? {};
  return members.map((/** @type {string} */ id) => rt.store.pending.session(id)).filter(Boolean);
}

/**
 * On another backend or model, what the last turn reported is no longer what runs: the row shows the setting until a
 * turn reports its own. Kiro on its router reports neither, and its row said “Opus 5.5, not auto” for good (#1315).
 * @param {import('./runtime.mjs').Runtime} rt @param {any} was  the persona before the change @param {any} next  after it
 */
export function forgetReported(rt, was, next) {
  if (next.backend === was.backend && next.model === was.model) return;
  for (const pending of Object.values(rt.store.pending.sessions()))
    if (pending.personaId === next.id && (pending.lastModel || pending.lastEffort)) rt.updateSession(pending.id, { lastModel: null, lastEffort: null });
}

// ── An agent’s one session in a conversation, moved here from server/conversations.mjs ──

/** One session per persona per thread. Adding a second agent turns a thread into a room. */
/**
 * @param {any} rt @param {string} threadId @param {string} personaId
 * @param {{ brief?: string|null, joined?: { by: string, in: string } | null }} [opts]
 *   joined: it joins to answer in a side thread, woken by `by` (a handle, or 'you') in thread `in` (#110)
 */
export function ensureSession(rt, threadId, personaId, { brief, joined = null } = {}) {
  // Read pending: a conversation createThread just wrote may still be held behind a commit.
  rt.threads.toWrite(threadId);
  const existing = pendingSessionsIn(rt, threadId).find((x) => x.personaId === personaId);
  if (existing) return existing;
  // Pending too: an agent the request just made may be held behind a commit with the thread.
  const p = rt.store.pending.persona(personaId);
  if (!p) throw httpError(404, 'That agent doesn’t exist.');
  const se = rt.putSession({
    id: newId('se'),
    personaId,
    threadId,
    handle: p.handle,
    backend: p.backend,
    state: 'idle',
    ctx: null,
    subagents: [],
    compactions: 0,
    toolCount: 0,
    toolCalls: [],
    currentStep: '',
    lastMessage: '',
    agentMessages: [],
    needs: null,
    unread: 0,
    startedAt: Date.now(),
    finishedAt: null,
    brief: brief ?? null,
    // The person never added it, so its row says why it’s here (decided by the person, 23 October 2026).
    ...(joined ? { joinedBy: joined.by, joinedIn: joined.in } : {}),
    // Nothing given yet: its first turn starts with the conversation so far (see catchUp).
    seenItem: null,
  });
  rt.threads.patch(threadId, (x) => ({ members: [...x.members, se.id], kind: x.kind === 'thread' && x.members.length > 0 ? 'room' : x.kind }));
  liftDecline(rt, threadId, p.handle); // the person added it: a decline of adding it here no longer holds (#789)
  return se;
}

// ── Archived conversations, moved here from server/unarchive.mjs ──

// Conversations can’t be archived any more: a store an older Postbox wrote can still hold an archived one (#101, #320),
// and a fork #228 retired as archived. As the store loads, each archived conversation and its agents come back as live
// ones, and a retired fork keeps only retiredFork, the flag that keeps it out of the rail and that no message reaches.

/**
 * Drops `archived` from every thread and session that still has it. O(threads + sessions), and it writes nothing once
 * a store has none. @param {import('./runtime.mjs').Runtime} rt
 */
export function unarchive(rt) {
  for (const t of rt.threads.pending()) if (Object.hasOwn(t, 'archived')) rt.threads.patch(t.id, { archived: undefined });
  for (const id of Object.keys(rt.s.sessions)) {
    const se = rt.store.pending.session(id);
    if (se && (Object.hasOwn(se, 'archived') || Object.hasOwn(se, 'archivedAt'))) rt.updateSession(id, { archived: undefined, archivedAt: undefined });
  }
}

// ── The commands each agent offers, moved here from server/agent-commands.mjs ──

/** The most skills and commands kept for an agent’s / menu. */
const MAX_COMMANDS = 200;

/**
 * Keeps an agent’s skills and commands on its session, bounded, for the / menu: from init (names; terminal-only
 * ones are already left out) or the SDK’s supportedCommands() (with descriptions and argument hints).
 * @param {string} sessionId @param {unknown} list
 */
export function recordCommands(rt, sessionId, list) {
  if (!rt.s.sessions[sessionId] || !Array.isArray(list)) return;
  const seen = new Set();
  const commands = [];
  for (const c of list) {
    const name = typeof c?.name === 'string' ? c.name.replace(/^\//, '').trim() : '';
    if (!name || name.length > 100 || seen.has(name) || !/^[\w:.@/-]+$/.test(name)) continue;
    seen.add(name);
    commands.push({
      name,
      ...(typeof c.description === 'string' && c.description.trim() ? { description: clipText(c.description.trim(), 200) } : {}),
      ...(typeof c.argumentHint === 'string' && c.argumentHint.trim() ? { argumentHint: clipText(c.argumentHint.trim(), 100) } : {}),
      ...(c.skill === true ? { skill: true } : {}),
    });
    if (commands.length >= MAX_COMMANDS) break;
  }
  rt.updateSession(sessionId, { commands: { at: Date.now(), list: commands } });
}
