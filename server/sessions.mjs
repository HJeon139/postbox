// Sessions (designs/architecture/services.md, “Sessions”): one per agent per conversation (#228), their unread counts,
// the Postbox notices an agent reads at the start of its next turn, and the commands each agent offers. Sessions is a
// service: Runtime’s constructor builds it with the store, the bus, Threads and Personas, and its code never takes the
// runtime. When an agent joins a conversation it signals session.joined, and the root’s listener lifts a decline of
// adding it there (#789). Needs stay with asks.
//
// The writes of a session that exists: its changed fields as a session.patch (server/session-patch.mjs). Each starts
// from the session as memory will hold it once what is held behind a commit is released (store.pending.session), as a
// thread write does (#796, server/threads.mjs): diffed against the published session, a change back to its published
// value was dropped behind a held change, and a notice appended to the published context dropped the one before it. A
// field built from the session's own is built in a function of the pending session; tests/session-write-guard.test.mjs
// places those still built from a published one.

import { itemOf } from '../shared/item-index.mjs';
import { clipText, httpError } from './helpers.mjs';
import { sessionPatch } from './session-patch.mjs';
import { newId } from './store.mjs';

/** The most skills and commands kept for an agent’s / menu. */
const MAX_COMMANDS = 200;

/**
 * An agent’s skills and commands, bounded and cleaned, for the / menu: from init (names; terminal-only ones are already
 * left out) or the SDK’s supportedCommands() (with descriptions and argument hints). @param {any[]} list
 */
function commandsOf(list) {
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
  return commands;
}

export class Sessions {
  /**
   * @param {{ store: import('./store.mjs').Store, bus: import('./bus.mjs').Bus, threads: import('./threads.mjs').Threads,
   *           personas: { get: (id: string) => any } }} deps
   */
  constructor({ store, bus, threads, personas }) {
    this.store = store;
    this.bus = bus;
    this.threads = threads;
    this.personas = personas;
  }

  // ── Reading ────────────────────────────────────────────────────────────────────────

  /** A session, or a 404 when it doesn’t exist. @param {string} id */
  get(id) {
    const se = this.store.state.sessions[id];
    if (!se) throw httpError(404, 'That session doesn’t exist. It may have been deleted.');
    return se;
  }

  /** A thread’s sessions, in the order they joined. @param {string} threadId */
  in(threadId) {
    return (this.store.state.threads[threadId]?.members ?? []).map((id) => this.store.state.sessions[id]).filter(Boolean);
  }

  /**
   * A thread's sessions as memory will hold them once what is held is released, as in() reads the published ones: for
   * a read that decides whether to make a session. One made behind a held commit is only pending, so a second
   * @-mention of the same new agent in that window made a second session, and one persona answered from two (intent.md:
   * one session per persona per conversation).
   * @param {string} threadId @returns {any[]}
   */
  pendingIn(threadId) {
    const { members = [] } = this.store.pending.thread(threadId) ?? {};
    return members.map((/** @type {string} */ id) => this.store.pending.session(id)).filter(Boolean);
  }

  /**
   * The other agents in a turn’s conversation, with their roles, for the guide: the room tells each agent who else is
   * here and what they do, so a persona’s own prompt needn’t know its team. A side or topic thread’s room is its
   * conversation’s.
   * @param {string} threadId @param {any} se  the agent the guide is for
   * @returns {{ handle: string, role: string }[]}
   */
  roomOf(threadId, se) {
    const threads = this.store.state.threads;
    const t = threads[threadId];
    const conv = t?.parentId && threads[t.parentId] ? t.parentId : threadId;
    const seen = new Set([se.handle]);
    return this.in(conv)
      .filter((x) => !x.retiredFork && !seen.has(x.handle) && seen.add(x.handle))
      .map((x) => ({ handle: x.handle, role: clipText(String(this.personas.get(x.personaId)?.description ?? ''), 200) }));
  }

  /**
   * The thread a session’s ask is in, when that isn’t its own: { threadId } to spread into its needs, so the overview
   * and ⌃J go to the side thread where the card is (#121).
   * @param {any} se @param {string|null|undefined} threadId
   */
  awayFrom(se, threadId) {
    return threadId && threadId !== se.threadId ? { threadId } : {};
  }

  // ── Joining ────────────────────────────────────────────────────────────────────────

  /**
   * An agent’s one session in a conversation: the one it has, or a new one. Adding a second agent turns a thread into
   * a room. A new one signals session.joined once it’s a member.
   * @param {string} threadId @param {string} personaId
   * @param {{ brief?: string|null, joined?: { by: string, in: string } | null }} [opts]
   *   joined: it joins to answer in a side thread, woken by `by` (a handle, or 'you') in thread `in` (#110)
   */
  ensure(threadId, personaId, { brief, joined = null } = {}) {
    // Read pending: a conversation createThread just wrote may still be held behind a commit.
    this.threads.toWrite(threadId);
    const existing = this.pendingIn(threadId).find((x) => x.personaId === personaId);
    if (existing) return existing;
    // Pending too: an agent the request just made may be held behind a commit with the thread.
    const p = this.store.pending.persona(personaId);
    if (!p) throw httpError(404, 'That agent doesn’t exist.');
    const se = {
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
    };
    this.store.emit('session', { ...se });
    this.threads.patch(threadId, (x) => ({ members: [...x.members, se.id], kind: x.kind === 'thread' && x.members.length > 0 ? 'room' : x.kind }));
    this.bus.emit('session.joined', { threadId, session: se, persona: p });
    return se;
  }

  // ── Writing ────────────────────────────────────────────────────────────────────────

  /**
   * Writes the fields of `change` that change the session, with updatedAt. `change` is the fields to set, or a function
   * of the pending session that returns them, so a field built from the session's own (its context, its backend state)
   * starts from what a held write left. A session that doesn’t exist isn’t written.
   * @param {string} id @param {Record<string, unknown> | ((se: any) => Record<string, unknown>)} change
   */
  update(id, change) {
    const se = this.store.pending.session(id);
    if (!se) return;
    const patch = typeof change === 'function' ? change(se) : change;
    this.store.emit('session.patch', sessionPatch(se, { ...patch, ...this.needAt(se, patch), updatedAt: Date.now() }));
  }

  /**
   * With a new need, the time its item was posted, as needsAt (#1155): ⌃J orders by it (shared/needs.mjs, waitedSince),
   * and the page holds no items of a conversation it hasn't opened. It names the need's item, so a need written another
   * way isn't given another's time; a cleared need clears it. Read pending, as the item may have been added behind a commit.
   * @param {any} se @param {Record<string, any>} patch
   */
  needAt(se, patch) {
    if (!Object.hasOwn(patch, 'needs')) return {};
    const need = patch.needs;
    const where = need?.threadId ?? (patch.sideTurn ?? se.sideTurn)?.threadId ?? se.threadId;
    const at = need?.itemId ? itemOf(this.store.pending.items(where), need.itemId)?.at : undefined;
    return { needsAt: at === undefined ? undefined : { itemId: need.itemId, at } };
  }

  /** Context the agent reads at the start of its next turn, as a Postbox notice. @param {string} id @param {string} text */
  tell(id, text) {
    this.update(id, (se) => ({ context: [...(se.context ?? []), `[Postbox] ${text}`].slice(-20) }));
  }

  /** Keeps an agent’s skills and commands on its session for the / menu. @param {string} id @param {unknown} list */
  recordCommands(id, list) {
    if (!this.store.state.sessions[id] || !Array.isArray(list)) return;
    this.update(id, { commands: { at: Date.now(), list: commandsOf(list) } });
  }

  /**
   * A browser has the thread open: its agents’ unread counts clear. Each is read pending, as the thread's next: an
   * unread a turn's end counted behind a held commit is cleared too (#796). @param {string} threadId
   */
  markRead(threadId) {
    for (const se of this.pendingIn(threadId)) if (se.unread) this.update(se.id, { unread: 0 });
  }

  /** Removes a session, as a delete does once its turn, wakes and jobs are dealt with. @param {string} id */
  remove(id) {
    if (this.store.pending.session(id)) this.store.emit('remove', { kind: 'session', id });
  }

  /**
   * On another backend or model, what the last turn reported is no longer what runs: the row shows the setting until a
   * turn reports its own. Kiro on its router reports neither, and its row said “Opus 5.5, not auto” for good (#1315).
   * The root runs it on persona.updated. @param {any} was  the persona before the change @param {any} next  after it
   */
  forgetReported(was, next) {
    if (next.backend === was.backend && next.model === was.model) return;
    for (const pending of Object.values(this.store.pending.sessions()))
      if (pending.personaId === next.id && (pending.lastModel || pending.lastEffort)) this.update(pending.id, { lastModel: null, lastEffort: null });
  }

  // ── As the store loads ─────────────────────────────────────────────────────────────

  /**
   * Every session that needs you from before needsAt, given its need's item time once (#1155): the page orders ⌃J by it
   * and holds no items of a conversation it hasn't opened. A need whose item is gone gets none, and waitedSince falls
   * back to the session's last change, as before.
   */
  stampNeeds() {
    for (const id of Object.keys(this.store.state.sessions)) {
      const se = this.store.pending.session(id);
      if (!se?.needs?.itemId || se.needsAt?.itemId === se.needs.itemId) continue;
      const { needsAt } = this.needAt(se, { needs: se.needs });
      if (needsAt) this.store.emit('session.patch', sessionPatch(se, { needsAt }));
    }
  }

  /**
   * Conversations can’t be archived any more: a store an older Postbox wrote can still hold an archived one (#101,
   * #320), and a fork #228 retired as archived. Each archived conversation and its agents come back as live ones, and a
   * retired fork keeps only retiredFork, the flag that keeps it out of the rail and that no message reaches.
   * O(threads + sessions), and it writes nothing once a store has none.
   */
  unarchive() {
    for (const t of this.threads.pending()) if (Object.hasOwn(t, 'archived')) this.threads.patch(t.id, { archived: undefined });
    for (const id of Object.keys(this.store.state.sessions)) {
      const se = this.store.pending.session(id);
      if (se && (Object.hasOwn(se, 'archived') || Object.hasOwn(se, 'archivedAt'))) this.update(id, { archived: undefined, archivedAt: undefined });
    }
  }
}
