// The runtime: threads, sessions and turns. It decides who replies, wakes agents, enforces the wake
// limit, queues messages sent mid-reply, handles Stop, tracks what "needs you", and implements the UI
// tools that agents call (over MCP, or in-process for the mock).

import { newId } from './store.mjs';
import { validateBlock, ASKING } from '../shared/catalog.mjs';
import { buildEvent } from '../shared/events.mjs';
import { parseMentions, formatDuration } from '../shared/text.mjs';
import { toPlainText } from '../shared/markdown.mjs';
import { lintTerms } from './lint.mjs';

export const HOP_LIMIT = 3;
const DELETE_UNDO_MS = 10000;
const clip = (s, n = 200) => { const t = toPlainText(s); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

export class Runtime {
  /**
   * @param {{ store: import('./store.mjs').Store, adapters: import('./adapters/adapter.mjs').AdapterRegistry,
   *           corpus: import('./corpus.mjs').Corpus, config: { origin: string, imageOrigins: string[] } }} deps
   */
  constructor({ store, adapters, corpus, config }) {
    this.store = store;
    this.adapters = adapters;
    this.corpus = corpus;
    this.config = config;
    this.turns = new Map();      // sessionId → live turn
    this.viewing = new Map();    // threadId → last time a browser said it was open
    this.timers = new Map();     // scheduleId or deletion → timeout
  }

  get s() { return this.store.state; }

  // ── Lookups ────────────────────────────────────────────────────────────────────────

  persona(id) { return this.s.personas[id]; }
  personaByHandle(handle) { return Object.values(this.s.personas).find((p) => p.handle.toLowerCase() === String(handle).toLowerCase() && !p.retired); }
  thread(id) {
    const t = this.s.threads[id];
    if (!t) throw httpError(404, 'That thread doesn’t exist. It may have been deleted.');
    return t;
  }
  session(id) {
    const se = this.s.sessions[id];
    if (!se) throw httpError(404, 'That session doesn’t exist. It may have been deleted.');
    return se;
  }
  sessionsIn(threadId) { return (this.s.threads[threadId]?.members ?? []).map((id) => this.s.sessions[id]).filter((x) => x && !x.deleting); }
  handles() { return Object.values(this.s.personas).filter((p) => !p.retired).map((p) => p.handle); }

  // ── Emit helpers ───────────────────────────────────────────────────────────────────

  putThread(t) { this.store.emit('thread', { ...t }); return t; }
  putSession(se) { this.store.emit('session', { ...se }); return se; }
  addItem(threadId, item) {
    const it = { id: item.id ?? newId('it'), at: Date.now(), ...item };
    this.store.emit('item.add', { threadId, item: it });
    return it;
  }
  patchItem(threadId, id, patch) { this.store.emit('item.patch', { threadId, id, patch }); }
  updateSession(id, patch) {
    const se = this.s.sessions[id];
    if (!se) return;
    this.putSession({ ...se, ...patch, updatedAt: Date.now() });
  }
  notify(level, se, title, text) {
    this.store.emit('notify', { level, sessionId: se.id, threadId: se.threadId, handle: se.handle, title, text });
  }

  // ── Projects, threads, sessions ────────────────────────────────────────────────────

  createThread({ projectId, title, personaIds = [], kind = 'thread', parentId = null }) {
    if (!this.s.projects[projectId]) throw httpError(404, 'That project doesn’t exist.');
    const t = this.putThread({ id: newId('th'), projectId, title: title || 'New thread', kind, parentId, members: [], lastSpeaker: null, hops: 0, queue: [], createdAt: Date.now(), archived: false });
    for (const pid of personaIds) this.ensureSession(t.id, pid);
    return this.s.threads[t.id];
  }

  /** One session per persona per thread. Adding a second agent turns a thread into a room. */
  ensureSession(threadId, personaId, { brief } = {}) {
    const t = this.thread(threadId);
    const existing = this.sessionsIn(threadId).find((x) => x.personaId === personaId);
    if (existing) return existing;
    const p = this.persona(personaId);
    if (!p) throw httpError(404, 'That agent doesn’t exist.');
    const se = this.putSession({
      id: newId('se'), personaId, threadId, handle: p.handle, personaVersion: p.version ?? 1, backend: p.backend,
      state: 'idle', ctx: 2, subagents: [], compactions: 0, toolCount: 0, toolCalls: [], currentStep: '', lastMessage: '',
      agentMessages: [], needs: null, unread: 0, startedAt: Date.now(), finishedAt: null, archived: false, brief: brief ?? null,
    });
    const members = [...t.members, se.id];
    this.putThread({ ...this.s.threads[threadId], members, kind: t.kind === 'thread' && members.length > 1 ? 'room' : t.kind });
    return se;
  }

  // ── Messages from you ──────────────────────────────────────────────────────────────

  /** You send a message: @mentions wake agents (joining them to the thread); otherwise the last speaker replies. */
  sendMessage(threadId, { text = '', attachments = [], sendNow = false } = {}) {
    const t = this.thread(threadId);
    text = String(text).slice(0, 50000);
    if (!text.trim() && !attachments.length) throw httpError(400, 'Write a message or attach a file first.');
    const mentioned = parseMentions(text, this.handles()).map((h) => this.personaByHandle(h)).filter(Boolean);
    const targets = [];
    for (const p of mentioned) {
      const joined = !this.sessionsIn(threadId).some((x) => x.personaId === p.id);
      const se = this.ensureSession(threadId, p.id, { brief: joined ? 'You were @-mentioned into this thread.' : null });
      targets.push({ se, woke: true });
    }
    if (!targets.length) {
      const members = this.sessionsIn(threadId).filter((x) => !x.archived);
      const last = members.find((x) => x.id === t.lastSpeaker) ?? members[0];
      if (!last) throw httpError(409, 'No agent is in this thread. @-mention one to bring it in.');
      targets.push({ se: last, woke: false });
    }
    // Messages to a busy agent wait in the queue unless you choose Send now.
    const busy = targets.filter(({ se }) => this.turns.has(se.id));
    if (busy.length && !sendNow) {
      const q = { id: newId('q'), text, attachments, sessionIds: targets.map(({ se }) => se.id), at: Date.now() };
      this.putThread({ ...this.s.threads[threadId], queue: [...(this.s.threads[threadId].queue ?? []), q] });
      return { queued: q };
    }
    for (const { se } of busy) this.stop(se.id, { silent: true });
    return this.postAndDeliver(threadId, { text, attachments }, targets);
  }

  postAndDeliver(threadId, { text, attachments }, targets) {
    const item = this.addItem(threadId, { kind: 'user', text, attachments });
    this.putThread({ ...this.s.threads[threadId], hops: 0 });
    for (const { se, woke } of targets) {
      if (woke) this.addItem(threadId, { kind: 'system', variant: 'wake', from: 'you', to: se.handle });
      this.deliver(se.id, { kind: 'user', text, attachments });
    }
    return { item };
  }

  editQueued(threadId, queueId, text) {
    const t = this.thread(threadId);
    const queue = (t.queue ?? []).map((q) => (q.id === queueId ? { ...q, text: String(text) } : q));
    this.putThread({ ...t, queue });
  }

  cancelQueued(threadId, queueId) {
    const t = this.thread(threadId);
    this.putThread({ ...t, queue: (t.queue ?? []).filter((q) => q.id !== queueId) });
  }

  /** Send now: stops the agent’s current turn and delivers the queued message at once. */
  sendQueuedNow(threadId, queueId) {
    const t = this.thread(threadId);
    const q = (t.queue ?? []).find((x) => x.id === queueId);
    if (!q) throw httpError(404, 'That queued message was already sent or removed.');
    this.putThread({ ...t, queue: t.queue.filter((x) => x.id !== queueId) });
    for (const id of q.sessionIds) this.stop(id, { silent: true });
    return this.postAndDeliver(threadId, q, q.sessionIds.map((id) => ({ se: this.s.sessions[id], woke: false })).filter((x) => x.se));
  }

  drainQueue(threadId) {
    const t = this.s.threads[threadId];
    if (!t?.queue?.length) return;
    const [q, ...rest] = t.queue;
    if (q.sessionIds.some((id) => this.turns.has(id))) return;
    this.putThread({ ...t, queue: rest });
    this.postAndDeliver(threadId, q, q.sessionIds.map((id) => ({ se: this.s.sessions[id], woke: false })).filter((x) => x.se));
  }

  // ── Turns ──────────────────────────────────────────────────────────────────────────

  /** Runs one agent turn through its adapter. */
  deliver(sessionId, message, { replyTo = null } = {}) {
    const se = this.session(sessionId);
    if (se.archived) throw httpError(409, `@${se.handle}’s session is archived. Restore it first.`);
    if (this.turns.has(sessionId)) {
      // Agent-to-agent messages and events wait for the current turn to end.
      const t = this.turns.get(sessionId);
      t.pending.push({ message, replyTo });
      return;
    }
    const persona = this.persona(se.personaId);
    const adapter = this.adapters.get(persona?.backend ?? 'mock');
    const abort = new AbortController();
    const turn = { id: newId('turn'), kind: message.kind, from: message.kind === 'agent' ? String(message.from ?? '').replace(/^@/, '').toLowerCase() : null, sessionId, threadId: se.threadId, segment: null, first: null, steps: [], abort, closed: false, replyTo, pending: [], said: '', startedAt: Date.now() };
    this.turns.set(sessionId, turn);
    this.updateSession(sessionId, { state: 'think', needs: message.kind === 'event' || message.kind === 'user' ? null : se.needs, currentStep: 'Thinking', finishedAt: null });
    const ctx = this.turnContext(se, turn);
    Promise.resolve()
      .then(() => adapter.deliver(this.s.sessions[sessionId], message, ctx))
      .then(() => this.endTurn(turn, null), (err) => this.endTurn(turn, err));
  }

  turnContext(se0, turn) {
    const rt = this;
    const live = () => !turn.closed;
    const se = () => rt.s.sessions[turn.sessionId];
    const ensureSegment = () => {
      if (!turn.segment) {
        const it = rt.addItem(turn.threadId, { kind: 'agent', sessionId: turn.sessionId, personaId: se0.personaId, handle: se0.handle, turnId: turn.id, text: '', status: 'streaming', activity: turn.first ? null : { steps: [] } });
        turn.segment = it.id;
        if (!turn.first) turn.first = it.id;
        if (turn.said) turn.said += '\n\n';
        rt.putThread({ ...rt.s.threads[turn.threadId], lastSpeaker: turn.sessionId });
      }
      return turn.segment;
    };
    const tools = this.toolsFor(turn.sessionId, turn);
    return {
      signal: turn.abort.signal,
      mcpUrl: `${this.config.origin}/mcp?session=${encodeURIComponent(turn.sessionId)}`,
      text(delta) {
        if (!live() || !delta) return;
        const id = ensureSegment();
        turn.said += delta;
        rt.store.emit('item.text', { threadId: turn.threadId, id, text: delta });
        if (se().state !== 'gen') rt.updateSession(turn.sessionId, { state: 'gen', currentStep: 'Writing a reply' });
      },
      activity({ id, label, state = 'running', ms = null }) {
        if (!live()) return;
        if (!turn.first) ensureSegment();
        const i = turn.steps.findIndex((s) => s.id === id);
        const step = { id: id ?? newId('st'), label: String(label).slice(0, 200), state, ms };
        if (i >= 0) turn.steps[i] = { ...turn.steps[i], ...step }; else turn.steps.push(step);
        rt.patchItem(turn.threadId, turn.first, { activity: { steps: [...turn.steps] } });
        const s = se();
        const calls = [{ name: step.label, state: step.state, ms: step.ms }, ...s.toolCalls.filter((c) => c.name !== step.label)].slice(0, 5);
        rt.updateSession(turn.sessionId, {
          state: state === 'running' ? 'tool' : s.state, toolCalls: calls,
          toolCount: s.toolCount + (i >= 0 ? 0 : 1), currentStep: state === 'running' ? step.label : s.currentStep,
        });
      },
      status(patch) {
        if (!live()) return;
        const allowed = {};
        if (patch.state && ['think', 'gen', 'tool'].includes(patch.state)) allowed.state = patch.state;
        if (typeof patch.ctx === 'number') allowed.ctx = Math.max(0, Math.min(100, Math.round(patch.ctx)));
        if (Array.isArray(patch.subagents)) allowed.subagents = patch.subagents.slice(0, 12).map((x) => ({ name: String(x.name).slice(0, 40), state: x.state, ctx: Math.max(0, Math.min(100, +x.ctx || 0)), doing: x.doing ? String(x.doing).slice(0, 120) : '' }));
        if (typeof patch.currentStep === 'string') allowed.currentStep = patch.currentStep.slice(0, 200);
        rt.updateSession(turn.sessionId, allowed);
      },
      compaction({ kept, total, summary }) {
        if (!live()) return;
        const n = se().compactions + 1;
        turn.segment = null;
        rt.addItem(turn.threadId, { kind: 'system', variant: 'compaction', handle: se0.handle, n, kept, total, summary: String(summary ?? '').slice(0, 20000) });
        rt.updateSession(turn.sessionId, { compactions: n, ctx: Math.round((kept / total) * 100) });
      },
      sources(list) {
        if (!live()) return;
        const id = ensureSegment();
        rt.patchItem(turn.threadId, id, { sources: list.slice(0, 50).map((x) => ({ title: String(x.title ?? ''), authors: String(x.authors ?? ''), year: x.year ?? null, url: x.url ?? null, note: x.note ? String(x.note) : '' })) });
      },
      tools,
    };
  }

  endTurn(turn, err) {
    if (turn.closed) return;
    turn.closed = true;
    this.turns.delete(turn.sessionId);
    const se = this.s.sessions[turn.sessionId];
    if (!se) return;
    const items = this.store.items(turn.threadId);
    for (const it of items) if (it.turnId === turn.id && it.kind === 'agent' && it.status === 'streaming') this.patchItem(turn.threadId, it.id, { status: err ? 'failed' : 'done' });
    if (err && err.name !== 'AbortError') {
      const message = err.userMessage ?? err.message ?? 'The agent stopped unexpectedly.';
      const target = turn.segment ?? turn.first ?? this.addItem(turn.threadId, { kind: 'agent', sessionId: se.id, personaId: se.personaId, handle: se.handle, turnId: turn.id, text: '', status: 'failed' }).id;
      this.patchItem(turn.threadId, target, { status: 'failed', error: message, retry: turn.retry ?? null });
      this.updateSession(se.id, { state: 'failed', needs: { kind: 'failed', itemId: target, text: message }, subagents: [], currentStep: 'Failed', finishedAt: Date.now() });
      this.notify('blocking', se, `@${se.handle}’s reply failed`, message);
      return;
    }
    // An app-check turn that ended without a new version: show the app with a note instead of waiting forever.
    if (turn.kind === 'app-check') {
      for (const app of Object.values(this.s.apps)) if (app.sessionId === se.id && app.check.status === 'fixing') this.store.emit('app', { ...app, check: { ...app.check, status: 'note' } });
    }
    const open = items.filter((it) => it.kind === 'block' && it.sessionId === se.id && it.valid && ASKING.has(it.block.type) && !it.answered);
    const last = [...items].reverse().find((it) => it.kind === 'agent' && it.sessionId === se.id && it.text);
    const viewing = this.isViewing(turn.threadId);
    const needs = open.length ? { kind: 'block', itemId: open.at(-1).id, text: open.at(-1).block.title ?? clip(open.at(-1).block.prompt ?? open.at(-1).block.fallback, 120) } : (se.needs?.kind === 'hop' ? se.needs : null);
    const mentionsYou = /(^|\W)@you\b/i.test(turn.said);
    this.updateSession(se.id, {
      state: needs ? 'needs' : 'idle', needs, subagents: [], currentStep: needs ? 'Waiting for you' : `Idle since ${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })}`,
      lastMessage: last ? clip(last.text) : se.lastMessage, finishedAt: Date.now(),
      unread: viewing ? 0 : se.unread + (turn.said || open.length ? 1 : 0),
    });
    if (needs && needs.kind === 'block') this.notify('blocking', se, `@${se.handle} needs you`, needs.text);
    else if (mentionsYou && !viewing) this.notify('info', se, `@${se.handle} mentioned you`, clip(turn.said, 120));
    else if (turn.said && !viewing) this.notify('info', se, `@${se.handle} finished`, clip(turn.said, 120));

    // Lint for coined terms the reply never defined; the agent gets the list and fixes it.
    const undefinedTerms = lintTerms(turn.said, this.s.glossary[turn.threadId] ?? {});
    // A lint turn is never linted again, so this can’t loop.
    if (undefinedTerms.length && turn.kind !== 'lint') this.deliver(se.id, { kind: 'lint', undefinedTerms });

    // An agent that @-mentions another agent wakes it.
    // Mentioning the agent you’re replying to isn’t a new wake: the reply already goes back to it.
    // Mentioning the agent that just wrote to you wakes it only if you ask it to check again.
    const replyTo = turn.replyTo ? this.s.sessions[turn.replyTo]?.handle?.toLowerCase() : null;
    for (const h of parseMentions(turn.said, this.handles())) {
      const hl = h.toLowerCase();
      if (hl === se.handle.toLowerCase() || hl === replyTo) continue;
      if (hl === turn.from && !/again|once more|loop/i.test(turn.said)) continue;
      this.agentWake(se.id, h, turn.said);
    }
    // A reply to an agent that woke this one goes back to it.
    if (turn.replyTo && this.s.sessions[turn.replyTo]) {
      this.deliver(turn.replyTo, { kind: 'agent', from: `@${se.handle}`, text: turn.said || '(no reply)' });
      this.recordAgentMessage(se.id, 'to', this.s.sessions[turn.replyTo].handle, turn.said);
      this.recordAgentMessage(turn.replyTo, 'from', se.handle, turn.said);
      this.bumpSideLink(turn.threadId);
    }
    const next = turn.pending.shift();
    if (next) {
      this.deliver(se.id, next.message, { replyTo: next.replyTo });
      const t = this.turns.get(se.id);
      if (t) t.pending.push(...turn.pending);
    } else this.drainQueue(turn.threadId);
  }

  /** Stop ends this agent’s turn and its subagents. Agents it woke keep running. */
  stop(sessionId, { silent = false } = {}) {
    const turn = this.turns.get(sessionId);
    if (!turn) return false;
    turn.abort.abort();
    turn.closed = true;
    this.turns.delete(sessionId);
    for (const it of this.store.items(turn.threadId)) {
      if (it.turnId === turn.id && it.kind === 'agent' && it.status === 'streaming') this.patchItem(turn.threadId, it.id, { status: 'stopped', stoppedAt: Date.now() });
    }
    if (!turn.segment && !turn.first) {
      this.addItem(turn.threadId, { kind: 'agent', sessionId, personaId: this.s.sessions[sessionId].personaId, handle: this.s.sessions[sessionId].handle, turnId: turn.id, text: '', status: 'stopped', stoppedAt: Date.now() });
    }
    this.updateSession(sessionId, { state: 'idle', subagents: [], currentStep: 'Stopped by you', finishedAt: Date.now() });
    if (!silent) this.drainQueue(turn.threadId);
    return true;
  }

  /** Retry a failed reply: sends the same message again. */
  retry(threadId, itemId) {
    const it = this.store.item(threadId, itemId);
    if (!it || it.status !== 'failed') throw httpError(409, 'Only a failed reply can be retried.');
    const prior = [...this.store.items(threadId)].reverse().find((x) => x.kind === 'user' && x.at <= it.at);
    this.patchItem(threadId, itemId, { status: 'retried' });
    this.updateSession(it.sessionId, { needs: null, state: 'idle' });
    this.deliver(it.sessionId, { kind: 'user', text: prior?.text ?? '', attachments: prior?.attachments ?? [], retry: true });
  }

  // ── Agents waking agents ───────────────────────────────────────────────────────────

  /** After HOP_LIMIT agent-to-agent wakes in a row without you, the next one waits for your confirm. */
  agentWake(fromSessionId, handle, text, { confirmed = false } = {}) {
    const from = this.s.sessions[fromSessionId];
    const p = this.personaByHandle(handle);
    if (!from || !p) return { ok: false, message: `There’s no agent called @${handle}.` };
    const t = this.s.threads[from.threadId];
    const parent = t.kind === 'side' ? this.s.threads[t.parentId] ?? t : t;
    if (!confirmed && (parent.hops ?? 0) >= HOP_LIMIT) {
      // One request at a time: further wakes wait behind the one you haven’t answered.
      if (this.store.items(parent.id).some((x) => x.kind === 'hop' && x.status === 'open')) return { ok: false, waiting: true, message: 'Another wake is already waiting for the person to allow it.' };
      const it = this.addItem(parent.id, { kind: 'hop', fromSessionId, from: from.handle, to: p.handle, reason: clip(text, 200), status: 'open', n: (parent.hops ?? 0) + 1 });
      this.updateSession(fromSessionId, { needs: { kind: 'hop', itemId: it.id, text: `@${from.handle} wants to wake @${p.handle}` }, state: this.turns.has(fromSessionId) ? from.state : 'needs' });
      this.notify('blocking', from, `Let @${from.handle} wake @${p.handle}?`, `That would be agent wake ${(parent.hops ?? 0) + 1} since your last message.`);
      return { ok: false, waiting: true, message: `Waiting for the person to allow waking @${p.handle}.` };
    }
    const hops = (parent.hops ?? 0) + 1;
    this.putThread({ ...this.s.threads[parent.id], hops });
    this.addItem(parent.id, { kind: 'system', variant: 'wake', from: from.handle, to: p.handle, n: hops, limit: HOP_LIMIT });
    // The exchange happens in a side thread; your thread shows one line that links to it.
    const pair = [from.handle, p.handle].sort().join('|');
    let side = Object.values(this.s.threads).find((x) => x.kind === 'side' && x.parentId === parent.id && x.pair === pair);
    if (!side) {
      side = this.putThread({ id: newId('th'), projectId: parent.projectId, title: `@${from.handle} ↔ @${p.handle}`, kind: 'side', parentId: parent.id, pair, members: [], lastSpeaker: null, hops: 0, queue: [], createdAt: Date.now(), archived: false });
      this.addItem(parent.id, { kind: 'sidelink', sideThreadId: side.id, from: from.handle, to: p.handle, count: 0 });
    }
    this.addItem(side.id, { kind: 'agent', sessionId: from.id, personaId: from.personaId, handle: from.handle, text, status: 'done' });
    this.recordAgentMessage(from.id, 'to', p.handle, text);
    const target = this.ensureSession(side.id, p.id);
    this.recordAgentMessage(target.id, 'from', from.handle, text);
    this.bumpSideLink(side.id);
    this.deliver(target.id, { kind: 'agent', from: `@${from.handle}`, text }, { replyTo: from.id });
    return { ok: true, message: `Woke @${p.handle}.` };
  }

  resolveHop(threadId, itemId, allow) {
    const it = this.store.item(threadId, itemId);
    if (!it || it.kind !== 'hop' || it.status !== 'open') throw httpError(409, 'That request was already answered.');
    this.patchItem(threadId, itemId, { status: allow ? 'allowed' : 'declined' });
    this.addItem(threadId, { kind: 'voice', text: allow ? `Allowed: @${it.from} wakes @${it.to}` : `Didn’t allow @${it.from} to wake @${it.to}` });
    const from = this.s.sessions[it.fromSessionId];
    if (from) this.updateSession(from.id, { needs: null, state: this.turns.has(from.id) ? from.state : 'idle' });
    this.putThread({ ...this.s.threads[threadId], hops: 0 });
    if (allow) this.agentWake(it.fromSessionId, it.to, it.reason, { confirmed: true });
    else if (from) this.deliver(from.id, { kind: 'notice', text: `The person chose not to let you wake @${it.to}. Carry on without it.` });
  }

  bumpSideLink(sideThreadId) {
    const side = this.s.threads[sideThreadId];
    if (side?.kind !== 'side') return;
    const link = this.store.items(side.parentId).find((x) => x.kind === 'sidelink' && x.sideThreadId === side.id);
    if (link) this.patchItem(side.parentId, link.id, { count: this.store.items(side.id).filter((x) => x.kind === 'agent' || x.kind === 'user').length });
  }

  recordAgentMessage(sessionId, dir, other, text) {
    const se = this.s.sessions[sessionId];
    if (!se) return;
    this.updateSession(sessionId, { agentMessages: [{ dir, other, text: clip(text, 120), at: Date.now() }, ...se.agentMessages].slice(0, 6) });
  }

  // ── Acting in blocks ───────────────────────────────────────────────────────────────

  act(threadId, itemId, action, values) {
    const it = this.store.item(threadId, itemId);
    if (!it) throw httpError(404, 'That block doesn’t exist any more.');
    if (it.kind === 'hop') return this.resolveHop(threadId, itemId, action === 'confirm');
    if (it.kind === 'proposal') return this.resolveProposal(threadId, itemId, action, values);
    if (it.kind !== 'block' || !it.valid) throw httpError(409, 'This block can’t be acted on.');
    if (it.answered) throw httpError(409, 'You already answered this. Only a new block, or an update to it, can ask again.');
    const r = buildEvent(it.block, action, values);
    if (!r.ok) throw Object.assign(httpError(422, r.error), { fieldErrors: r.fieldErrors });
    // Progress, image and code never ask; a card or table action doesn’t lock the block.
    const locks = ASKING.has(it.block.type);
    if (locks) this.patchItem(threadId, itemId, { answered: true, answer: { action, values: r.event.values, voice: r.voice, at: Date.now() } });
    this.addItem(threadId, { kind: 'voice', text: r.voice, blockItemId: itemId });
    const se = this.s.sessions[it.sessionId];
    if (se?.needs?.itemId === itemId) this.updateSession(se.id, { needs: null, state: this.turns.has(se.id) ? se.state : 'idle' });
    if (se) this.deliver(se.id, { kind: 'event', event: r.event });
    return { ok: true, voice: r.voice };
  }

  resolveProposal(threadId, itemId, action) {
    const it = this.store.item(threadId, itemId);
    if (it.status !== 'open') throw httpError(409, 'That proposal was already answered.');
    if (action === 'dismiss') {
      this.patchItem(threadId, itemId, { status: 'dismissed' });
      this.addItem(threadId, { kind: 'voice', text: `Dismissed: @${it.proposal.handle}` });
      return { ok: true };
    }
    if (action !== 'create') throw httpError(400, 'A proposal accepts “create” or “dismiss”. To edit it first, open the new-agent sheet.');
    const p = this.createPersona({ ...it.proposal, createdBy: it.sessionId });
    this.patchItem(threadId, itemId, { status: 'created', personaId: p.id });
    this.addItem(threadId, { kind: 'voice', text: `Created @${p.handle}` });
    this.ensureSession(threadId, p.id, { brief: it.proposal.description });
    this.addItem(threadId, { kind: 'system', variant: 'joined', to: p.handle });
    return { ok: true, personaId: p.id };
  }

  // ── Personas ───────────────────────────────────────────────────────────────────────

  createPersona({ handle, description = '', instructions = '', model = 'mock', backend = 'mock', tools = [], examples = [], createdBy = null }) {
    handle = String(handle ?? '').replace(/^@/, '').trim();
    if (!/^[a-z][a-z0-9_-]{1,23}$/i.test(handle)) throw httpError(422, 'A name uses 2–24 letters, digits, - or _, and starts with a letter.');
    if (this.personaByHandle(handle)) throw httpError(409, `@${handle} already exists. Pick another name.`);
    if (!this.adapters.names().includes(backend)) throw httpError(422, `“${backend}” isn’t available yet. Stage 2 runs agents on the mock only.`);
    const p = { id: newId('pe'), handle, description, instructions, model, backend, tools: [...new Set(tools)], examples, createdBy, createdAt: Date.now(), version: 1, retired: false };
    this.store.emit('persona', p);
    return p;
  }

  updatePersona(id, patch) {
    const p = this.persona(id);
    if (!p) throw httpError(404, 'That agent doesn’t exist.');
    const next = { ...p, ...pick(patch, ['description', 'instructions', 'model', 'tools', 'examples', 'retired']), version: (p.version ?? 1) + 1 };
    this.store.emit('persona', next);
    return next;
  }

  // ── Session lifecycle: archive, restore, delete with undo ─────────────────────────

  archive(sessionId) {
    this.stop(sessionId, { silent: true });
    const se = this.session(sessionId);
    this.updateSession(sessionId, { archived: true, state: 'idle', needs: null, archivedAt: Date.now() });
    const t = this.s.threads[se.threadId];
    if (t && this.sessionsIn(t.id).every((x) => x.id === sessionId || x.archived)) this.putThread({ ...t, archived: true });
  }

  restore(sessionId) {
    const se = this.session(sessionId);
    this.updateSession(sessionId, { archived: false, archivedAt: null });
    const t = this.s.threads[se.threadId];
    if (t?.archived) this.putThread({ ...t, archived: false });
  }

  /** Deletes after DELETE_UNDO_MS unless undone. The persona always stays. */
  deleteSession(sessionId) {
    this.stop(sessionId, { silent: true });
    const se = this.session(sessionId);
    const until = Date.now() + DELETE_UNDO_MS;
    this.updateSession(sessionId, { deleting: until });
    clearTimeout(this.timers.get(`del:${sessionId}`));
    this.timers.set(`del:${sessionId}`, setTimeout(() => this.purgeSession(sessionId), DELETE_UNDO_MS));
    return { until, handle: se.handle };
  }

  undoDelete(sessionId) {
    clearTimeout(this.timers.get(`del:${sessionId}`));
    this.timers.delete(`del:${sessionId}`);
    const se = this.session(sessionId);
    this.updateSession(sessionId, { deleting: null });
  }

  purgeSession(sessionId) {
    this.timers.delete(`del:${sessionId}`);
    const se = this.s.sessions[sessionId];
    if (!se?.deleting) return;
    const t = this.s.threads[se.threadId];
    const others = (t?.members ?? []).filter((id) => id !== sessionId && this.s.sessions[id]);
    if (t && !others.length) {
      // Its own thread: erase the thread, its apps and its side threads.
      for (const app of Object.values(this.s.apps)) if (app.threadId === t.id) this.store.emit('remove', { kind: 'app', id: app.id });
      for (const side of Object.values(this.s.threads)) if (side.parentId === t.id) this.store.emit('remove', { kind: 'thread', id: side.id });
      this.store.emit('remove', { kind: 'thread', id: t.id });
    } else if (t) {
      // In a room: it leaves, and its past messages stay, marked deleted.
      this.putThread({ ...t, members: others, lastSpeaker: t.lastSpeaker === sessionId ? others[0] ?? null : t.lastSpeaker });
      for (const it of this.store.items(t.id)) if (it.sessionId === sessionId) this.patchItem(t.id, it.id, { deletedAgent: true });
      this.addItem(t.id, { kind: 'system', variant: 'left', to: se.handle });
    }
    this.store.emit('remove', { kind: 'session', id: sessionId });
  }

  // ── Scheduled wake-ups ─────────────────────────────────────────────────────────────

  schedule(sessionId, { inMs, note }) {
    const se = this.session(sessionId);
    const at = Date.now() + Math.max(1000, Math.min(inMs, 7 * 24 * 3600 * 1000));
    const sc = { id: newId('sc'), sessionId, threadId: se.threadId, handle: se.handle, at, note: String(note ?? '').slice(0, 200) };
    this.store.emit('schedule', sc);
    const it = this.addItem(se.threadId, { kind: 'system', variant: 'schedule', scheduleId: sc.id, handle: se.handle, at, note: sc.note, status: 'pending' });
    sc.itemId = it.id;
    this.store.emit('schedule', sc);
    this.arm(sc);
    return sc;
  }

  arm(sc) {
    clearTimeout(this.timers.get(sc.id));
    this.timers.set(sc.id, setTimeout(() => {
      this.timers.delete(sc.id);
      if (!this.s.schedules[sc.id]) return;
      this.store.emit('schedule', { id: sc.id, removed: true });
      if (sc.itemId) this.patchItem(sc.threadId, sc.itemId, { status: 'done' });
      if (!this.s.sessions[sc.sessionId]) return;
      this.addItem(sc.threadId, { kind: 'system', variant: 'wake', from: sc.handle, to: sc.handle, scheduled: true });
      this.deliver(sc.sessionId, { kind: 'wake', note: sc.note });
    }, Math.max(0, sc.at - Date.now())));
  }

  cancelSchedule(scheduleId) {
    const sc = this.s.schedules[scheduleId];
    if (!sc) throw httpError(404, 'That wake-up already happened or was cancelled.');
    clearTimeout(this.timers.get(scheduleId));
    this.store.emit('schedule', { id: scheduleId, removed: true });
    if (sc.itemId) this.patchItem(sc.threadId, sc.itemId, { status: 'cancelled' });
  }

  rearmSchedules() { for (const sc of Object.values(this.s.schedules)) this.arm(sc); }

  // ── Apps ───────────────────────────────────────────────────────────────────────────

  /** The browser reports its pre-display check. The first failure goes back to the agent to fix. */
  appCheck(appId, { version, problems = [] }) {
    const app = this.s.apps[appId];
    if (!app) throw httpError(404, 'That app doesn’t exist.');
    if (version !== app.current) return { ignored: true };
    const clean = problems.slice(0, 20).map((p) => ({ code: String(p.code).slice(0, 40), message: String(p.message).slice(0, 300) }));
    if (!clean.length) { this.store.emit('app', { ...app, check: { status: 'passed', attempt: app.check.attempt, problems: [] } }); return { status: 'passed' }; }
    if (clean.some((p) => p.code === 'script-error')) {
      this.store.emit('app', { ...app, check: { status: 'crashed', attempt: app.check.attempt, problems: clean } });
      return { status: 'crashed' };
    }
    // Problems the agent can’t fix (the frame never answered) are shown as a note, not sent back.
    const fixable = clean.filter((p) => p.code !== 'no-answer');
    if (app.check.attempt === 0 && fixable.length && this.s.sessions[app.sessionId]) {
      this.store.emit('app', { ...app, check: { status: 'fixing', attempt: 1, problems: fixable } });
      this.deliver(app.sessionId, { kind: 'app-check', appId, problems: fixable });
      return { status: 'fixing' };
    }
    this.store.emit('app', { ...app, check: { status: 'note', attempt: app.check.attempt, problems: clean } });
    return { status: 'note' };
  }

  appEvent(appId, action, values) {
    const app = this.s.apps[appId];
    if (!app) throw httpError(404, 'That app doesn’t exist.');
    const r = buildEvent({ type: 'app', id: appId, title: app.title }, action, values);
    if (!r.ok) throw httpError(422, r.error);
    this.addItem(app.threadId, { kind: 'voice', text: r.voice, appId });
    if (this.s.sessions[app.sessionId]) this.deliver(app.sessionId, { kind: 'event', event: r.event });
    return { ok: true, voice: r.voice };
  }

  appState(appId, state) {
    const app = this.s.apps[appId];
    if (!app) throw httpError(404, 'That app doesn’t exist.');
    const json = JSON.stringify(state ?? null);
    if (json.length > 256 * 1024) throw httpError(413, 'Saved app state is limited to 256 KB.');
    this.store.emit('app', { ...app, state: JSON.parse(json) });
  }

  /** An app asks the host for data. It can use only tools both it and its agent were granted. */
  appQuery(appId, tool, args) {
    const app = this.s.apps[appId];
    if (!app) throw httpError(404, 'That app doesn’t exist.');
    const se = this.s.sessions[app.sessionId];
    const persona = se && this.persona(se.personaId);
    const allowed = new Set((app.versions[app.current - 1].permissions ?? []).filter((t) => persona?.tools?.includes(t)));
    if (!allowed.has(tool)) throw httpError(403, `This app can’t use “${tool}”. It needs the permission, and its agent needs the tool.`);
    return hostTool(this, tool, args);
  }

  // ── Presence ───────────────────────────────────────────────────────────────────────

  view(threadId) {
    if (!threadId) return;
    this.viewing.set(threadId, Date.now());
    for (const se of this.sessionsIn(threadId)) if (se.unread) this.updateSession(se.id, { unread: 0 });
  }
  isViewing(threadId) { return Date.now() - (this.viewing.get(threadId) ?? 0) < 20000; }

  // ── UI tools (the same set MCP exposes) ────────────────────────────────────────────

  toolsFor(sessionId, turn = null) {
    const rt = this;
    const se = () => rt.session(sessionId);
    const endSegment = () => { if (turn) turn.segment = null; };
    const threadId = () => se().threadId;
    return {
      show_block({ block }) {
        const v = validateBlock(block, { imageOrigins: rt.config.imageOrigins });
        endSegment();
        const it = rt.addItem(threadId(), v.ok
          ? { kind: 'block', sessionId, handle: se().handle, turnId: turn?.id ?? null, valid: true, block: v.block, answered: false }
          : { kind: 'block', sessionId, handle: se().handle, turnId: turn?.id ?? null, valid: false, raw: block, errors: v.errors, reason: v.reason, fallback: v.fallback });
        if (v.ok && v.block.type === 'app') rt.registerApp(sessionId, v.block, it.id);
        return v.ok ? { ok: true, message: `Shown block ${v.block.id}.` } : { ok: false, message: `The block was invalid, so the person sees its fallback text. Problems: ${v.errors.join(' ')}` };
      },
      update_block({ block }) {
        const v = validateBlock(block, { imageOrigins: rt.config.imageOrigins });
        if (!v.ok) return { ok: false, message: `The update was invalid and wasn’t applied: ${v.errors.join(' ')}` };
        const existing = [...rt.store.items(threadId())].reverse().find((x) => x.kind === 'block' && x.valid && x.block.id === v.block.id && x.sessionId === sessionId);
        if (!existing) return { ok: false, message: `There’s no block with id ${v.block.id} to update. Use show_block to add it.` };
        if (existing.block.type !== v.block.type) return { ok: false, message: 'An update can’t change a block’s type.' };
        // An update can ask again, so it reopens a block you already answered.
        rt.patchItem(threadId(), existing.id, { block: v.block, answered: false, answer: null, revision: (existing.revision ?? 1) + 1 });
        return { ok: true, message: `Updated block ${v.block.id}.` };
      },
      show_app({ id, title, code, permissions = [], fallback }) {
        const blockId = id ?? newId('app');
        const existing = rt.s.apps[blockId];
        if (existing) return this.update_app({ id: blockId, code, permissions, title });
        return this.show_block({ block: { id: blockId, type: 'app', version: 1, title: title ?? 'App', fallback: fallback ?? `${title ?? 'An app'}: open Postbox to use it.`, code, permissions } });
      },
      update_app({ id, code, permissions, title, summary }) {
        const app = rt.s.apps[id];
        if (!app || app.sessionId !== sessionId) return { ok: false, message: `There’s no app with id ${id} from you.` };
        const v = validateBlock({ id, type: 'app', version: 1, fallback: 'x', code, permissions: permissions ?? app.versions[app.current - 1].permissions });
        if (!v.ok) return { ok: false, message: `The update was invalid: ${v.errors.join(' ')}` };
        const versions = [...app.versions, { v: app.versions.length + 1, code, permissions: v.block.permissions ?? [], summary: summary ?? '', at: Date.now() }];
        rt.store.emit('app', { ...app, title: title ?? app.title, versions, current: versions.length, check: { status: 'pending', attempt: app.check.attempt } });
        return { ok: true, message: `App ${id} is now v${versions.length}.` };
      },
      define_term({ term, definition, key, source }) {
        if (!term || !definition) return { ok: false, message: 'define_term needs a term and a definition.' };
        const k = String(key ?? term).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64) || 'term';
        rt.store.emit('glossary', { threadId: threadId(), entry: { key: k, term: String(term).slice(0, 80), definition: String(definition).slice(0, 2000), source: source ? String(source).slice(0, 200) : '', by: se().handle, at: Date.now() } });
        return { ok: true, message: `Defined “${term}”.` };
      },
      propose_agent({ handle, description, instructions, tools = [], model = 'mock', backend = 'mock' }) {
        const mine = new Set(rt.persona(se().personaId)?.tools ?? []);
        endSegment();
        rt.addItem(threadId(), { kind: 'proposal', sessionId, handle: se().handle, status: 'open', proposal: { handle: String(handle).replace(/^@/, ''), description, instructions, tools, model, backend }, extraTools: tools.filter((t) => !mine.has(t)) });
        return { ok: true, message: 'Proposed. The person decides whether to create it.' };
      },
      schedule_wake({ in_minutes, note }) {
        const sc = rt.schedule(sessionId, { inMs: Math.round((+in_minutes || 1) * 60000), note });
        return { ok: true, message: `You’ll be woken at ${new Date(sc.at).toISOString()}.` };
      },
      wake_agent({ handle, message }) {
        return rt.agentWake(sessionId, String(handle).replace(/^@/, ''), String(message ?? ''));
      },
      corpus_search(args) { return { ok: true, results: hostTool(rt, 'corpus.search', args) }; },
    };
  }

  registerApp(sessionId, block, itemId) {
    const se = this.s.sessions[sessionId];
    this.store.emit('app', {
      id: block.id, threadId: se.threadId, sessionId, itemId, title: block.title ?? 'App',
      versions: [{ v: 1, code: block.code, permissions: block.permissions ?? [], at: Date.now(), summary: '' }], current: 1,
      state: null, check: { status: 'pending', attempt: 0, problems: [] },
    });
  }
}

/** Host tools that apps (through the bridge) and agents can use, if granted. */
export function hostTool(rt, tool, args = {}) {
  switch (tool) {
    case 'corpus.search': {
      const q = String(args.query ?? '').slice(0, 200);
      const mode = ['both', 'lexical', 'semantic'].includes(args.mode) ? args.mode : 'both';
      return rt.corpus.search(q, { mode, k: Math.min(50, +args.k || 12), books: Array.isArray(args.books) ? args.books : undefined });
    }
    case 'corpus.read': return rt.corpus.read(String(args.id ?? ''));
    case 'corpus.stats': return rt.corpus.stats();
    default: throw httpError(404, `There’s no host tool called “${tool}”.`);
  }
}

export function httpError(status, message) { return Object.assign(new Error(message), { status, userMessage: message }); }
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
export { formatDuration };
