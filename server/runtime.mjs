// The runtime: threads, sessions and turns. It decides who replies, wakes agents, enforces the wake
// limit, queues messages sent mid-reply, handles Stop, tracks what "needs you", and implements the UI
// tools that agents call (over MCP, or in-process for the mock).

import { createHash } from 'node:crypto';
import { basename, resolve, sep } from 'node:path';
import { ASKING, validateBlock } from '../shared/catalog.mjs';
import { COLUMN_PX, lintDiagrams, MIN_TEXT_PX, mermaidBlocks } from '../shared/diagram-lint.mjs';
import { buildEvent } from '../shared/events.mjs';
import { toPlainText } from '../shared/markdown.mjs';
import { formatDuration, parseMentions } from '../shared/text.mjs';
import { describeTool } from './adapters/claude-stream.mjs';
import { listClaudeSessions, recentHistory, TranscriptTail, typedText } from './adapters/terminal-mirror.mjs';
import { diagramProblems, formatLint, introducedTerms, lintMessage, termProblems } from './checks.mjs';
import { addAllowRule, rulesFor } from './permission-rules.mjs';
import { newId } from './store.mjs';

export const HOP_LIMIT = 3;
const DELETE_UNDO_MS = 10000;
/** How long a lint turn waits after its agent turn ends for what the browser measures (diagrams, the app check). */
const LINT_SETTLE_MS = 1500;
/** …and at most, while an app of the agent’s is still being checked. */
const LINT_WAIT_MAX_MS = 12000;
/** App check problems that are warnings: the app is shown, with notes, and the agent is told. */
const APP_WARNINGS = new Set(['marks-too-small', 'text-too-small', 'dashes-too-fine', 'only-error']);
/**
 * What a persona may do without asking. auto (the default): Claude Code’s safety classifier approves routine
 * actions and asks you only when it can’t decide. ask: ask before anything risky. acceptEdits: edit files
 * freely, ask before commands. bypass: never ask.
 */
export const PERMISSION_MODES = ['auto', 'ask', 'acceptEdits', 'bypass'];
const STEP_STATES = new Set(['running', 'done', 'failed', 'denied']);
/** The model a real backend uses when a persona doesn’t name one. */
export const DEFAULT_MODEL = 'claude-opus-5-5';
const CATCH_UP_ITEMS = 40;
const CATCH_UP_CHARS = 16000;
const clipText = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const clip = (s, n = 200) => {
  const t = toPlainText(s);
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

export class Runtime {
  /**
   * @param {{ store: import('./store.mjs').Store, adapters: import('./adapters/adapter.mjs').AdapterRegistry,
   *           corpus: import('./corpus.mjs').Corpus, config: { origin: string, imageOrigins: string[], claudeProjectsRoot?: string, versions?: any, lintSettleMs?: number },
   *           blobs?: import('./blobs.mjs').Blobs, narrator?: import('./narration/narrator.mjs').Narrator|null }} deps
   */
  constructor({ store, adapters, corpus, config, blobs, narrator }) {
    this.store = store;
    this.adapters = adapters;
    this.corpus = corpus;
    this.config = config;
    this.blobs = blobs ?? null;
    this.narrator = narrator ?? null;
    this.permissionWaits = new Map(); // permission item id → { resolve, threadId, sessionId }
    this.mirrors = new Map(); // attached session id → { tail, timer, agentItem, steps }
    this.turns = new Map(); // sessionId → live turn
    this.viewing = new Map(); // threadId → last time a browser said it was open
    this.timers = new Map(); // scheduleId or deletion → timeout
    this.lints = new Map(); // agent turn id → its lint turn, gathering: { sessionId, kind, ended, sent, problems, timer }
  }

  get s() {
    return this.store.state;
  }

  // ── Lookups ────────────────────────────────────────────────────────────────────────

  persona(id) {
    return this.s.personas[id];
  }
  /**
   * The persona as this session started with it. Sessions from before snapshots use the current one. Where it
   * runs and what it may do without asking follow the persona from the next turn, so changing them reaches
   * conversations that are already going.
   */
  personaFor(se) {
    const p = this.persona(se.personaId);
    return p && { ...p, ...(se.personaSnapshot ?? {}), backend: p.backend, permissionMode: p.permissionMode ?? 'auto' };
  }
  personaByHandle(handle) {
    return Object.values(this.s.personas).find((p) => p.handle.toLowerCase() === String(handle).toLowerCase() && !p.retired);
  }
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
  sessionsIn(threadId) {
    return (this.s.threads[threadId]?.members ?? []).map((id) => this.s.sessions[id]).filter((x) => x && !x.deleting);
  }
  handles() {
    return Object.values(this.s.personas)
      .filter((p) => !p.retired)
      .map((p) => p.handle);
  }

  // ── Emit helpers ───────────────────────────────────────────────────────────────────

  putThread(t) {
    this.store.emit('thread', { ...t });
    return t;
  }
  putSession(se) {
    this.store.emit('session', { ...se });
    return se;
  }
  addItem(threadId, item) {
    const it = { id: item.id ?? newId('it'), at: Date.now(), ...item };
    this.store.emit('item.add', { threadId, item: it });
    // A reply in a topic thread counts on the message it branched from, as “3 replies”.
    const t = this.s.threads[threadId];
    if (t?.kind === 'topic' && (it.kind === 'user' || it.kind === 'agent')) {
      const replies = this.store.items(threadId).filter((x) => x.kind === 'user' || x.kind === 'agent').length;
      this.patchItem(t.parentId, t.rootItemId, { replies, lastReplyAt: it.at });
    }
    return it;
  }
  patchItem(threadId, id, patch) {
    this.store.emit('item.patch', { threadId, id, patch });
  }
  updateSession(id, patch) {
    const se = this.s.sessions[id];
    if (!se) return;
    this.putSession({ ...se, ...patch, updatedAt: Date.now() });
  }
  notify(level, se, title, text) {
    this.store.emit('notify', { level, sessionId: se.id, threadId: se.threadId, handle: se.handle, title, text });
  }

  // ── Projects, threads, sessions ────────────────────────────────────────────────────

  /** @param {{ projectId: string, title: string, personaIds?: string[], kind?: string, parentId?: string|null }} opts */
  createThread({ projectId, title, personaIds = [], kind = 'thread', parentId = null }) {
    if (!this.s.projects[projectId]) throw httpError(404, 'That project doesn’t exist.');
    const t = this.putThread({
      id: newId('th'),
      projectId,
      title: title || 'New thread',
      kind,
      parentId,
      members: [],
      lastSpeaker: null,
      hops: 0,
      queue: [],
      createdAt: Date.now(),
      archived: false,
    });
    for (const pid of personaIds) this.ensureSession(t.id, pid);
    return this.s.threads[t.id];
  }

  /** One session per persona per thread. Adding a second agent turns a thread into a room. */
  /** @param {string} threadId @param {string} personaId @param {{ brief?: string|null }} [opts] */
  ensureSession(threadId, personaId, { brief } = {}) {
    const t = this.thread(threadId);
    const existing = this.sessionsIn(threadId).find((x) => x.personaId === personaId);
    if (existing) return existing;
    const p = this.persona(personaId);
    if (!p) throw httpError(404, 'That agent doesn’t exist.');
    const se = this.putSession({
      id: newId('se'),
      personaId,
      threadId,
      handle: p.handle,
      personaVersion: p.version ?? 1,
      // What the agent runs with is fixed when the session starts; editing the persona changes new sessions.
      personaSnapshot: snapshotOf(p),
      backend: p.backend,
      state: 'idle',
      ctx: 2,
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
      archived: false,
      brief: brief ?? null,
      // Nothing given yet: its first turn starts with the conversation so far (see catchUp).
      seenItem: null,
    });
    const members = [...t.members, se.id];
    this.putThread({ ...this.s.threads[threadId], members, kind: t.kind === 'thread' && members.length > 1 ? 'room' : t.kind });
    return se;
  }

  // ── Messages from you ──────────────────────────────────────────────────────────────

  /** You send a message: @mentions wake agents (joining them to the thread); otherwise the last speaker replies. */
  sendMessage(threadId, { text = '', attachments = [], sendNow = false } = {}) {
    const t = this.thread(threadId);
    if (t.deleting) throw httpError(409, 'This conversation is being deleted. Undo it first.');
    text = String(text).slice(0, 50000);
    if (!text.trim() && !attachments.length) throw httpError(400, 'Write a message or attach a file first.');
    const mentioned = parseMentions(text, this.handles())
      .map((h) => this.personaByHandle(h))
      .filter(Boolean);
    const targets = [];
    // Refuse before anything is posted, so a refused message doesn’t also appear in the transcript.
    const archived = mentioned.map((p) => this.sessionsIn(threadId).find((x) => x.personaId === p.id)).find((x) => x?.archived);
    if (archived) throw httpError(409, `@${archived.handle}’s session is archived. Restore it first.`);
    for (const p of mentioned) {
      const joined = !this.sessionsIn(threadId).some((x) => x.personaId === p.id);
      // In a topic thread, an agent from the conversation joins as a fork of its session there.
      const from = joined && t.kind === 'topic' ? this.sessionsIn(t.parentId).find((x) => x.personaId === p.id) : null;
      const se = from
        ? this.forkSession(from.id, threadId)
        : this.ensureSession(threadId, p.id, { brief: joined ? 'You were @-mentioned into this thread.' : null });
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
      this.deliver(se.id, { kind: 'user', text, attachments, itemId: item.id });
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
    return this.postAndDeliver(
      threadId,
      q,
      q.sessionIds.map((id) => ({ se: this.s.sessions[id], woke: false })).filter((x) => x.se),
    );
  }

  drainQueue(threadId) {
    const t = this.s.threads[threadId];
    if (!t?.queue?.length) return;
    const [q, ...rest] = t.queue;
    if (q.sessionIds.some((id) => this.turns.has(id))) return;
    this.putThread({ ...t, queue: rest });
    this.postAndDeliver(
      threadId,
      q,
      q.sessionIds.map((id) => ({ se: this.s.sessions[id], woke: false })).filter((x) => x.se),
    );
  }

  // ── Turns ──────────────────────────────────────────────────────────────────────────

  /** Runs one agent turn through its adapter. */
  deliver(sessionId, message, { replyTo = null, summarizeTo = null } = {}) {
    const se = this.session(sessionId);
    if (se.archived) throw httpError(409, `@${se.handle}’s session is archived. Restore it first.`);
    if (this.turns.has(sessionId)) {
      // Agent-to-agent messages and events wait for the current turn to end.
      const t = this.turns.get(sessionId);
      t.pending.push({ message, replyTo, summarizeTo });
      return;
    }
    // Problems the checks found in its last reply, still waiting to go as a lint turn, come with this turn instead.
    if (message.kind !== 'lint') message = this.foldLint(sessionId, message);
    // Context that waited for this agent’s next turn (shared from a topic thread, or a topic’s brief) goes first.
    if (se.context?.length) {
      message = { ...message, context: se.context };
      this.updateSession(sessionId, { context: [] });
    }
    // And before that, what happened in the conversation since this agent last took part: a room is shared
    // memory, so an agent that wasn’t woken for something can still catch up on it (issue #1).
    const catchUp = this.catchUp(this.s.sessions[sessionId], message.itemId);
    if (catchUp) message = { ...message, context: [catchUp, ...(message.context ?? [])] };
    const persona = this.persona(se.personaId);
    const adapter = this.adapters.get(persona?.backend ?? 'mock');
    const abort = new AbortController();
    const turn = {
      id: newId('turn'),
      kind: message.kind,
      from:
        message.kind === 'agent'
          ? String(message.from ?? '')
              .replace(/^@/, '')
              .toLowerCase()
          : null,
      sessionId,
      threadId: se.threadId,
      segment: null,
      first: null,
      steps: [],
      abort,
      closed: false,
      replyTo,
      summarizeTo,
      checkpoint: null,
      pending: [],
      said: '',
      startedAt: Date.now(),
    };
    this.turns.set(sessionId, turn);
    // Rules the person allowed once (from a refusal card) apply to this turn only.
    turn.allowOnce = se.allowOnce ?? [];
    this.updateSession(sessionId, {
      allowOnce: [],
      glimpse: '',
      state: 'think',
      needs: message.kind === 'event' || message.kind === 'user' ? null : se.needs,
      currentStep: 'Thinking',
      finishedAt: null,
    });
    const ctx = this.turnContext(se, turn);
    Promise.resolve()
      .then(() => adapter.deliver(this.s.sessions[sessionId], message, ctx))
      .then(
        () => this.endTurn(turn, null),
        (err) => this.endTurn(turn, err),
      );
  }

  turnContext(se0, turn) {
    const rt = this;
    const live = () => !turn.closed;
    const se = () => rt.s.sessions[turn.sessionId];
    const ensureSegment = () => {
      if (!turn.segment) {
        const it = rt.addItem(turn.threadId, {
          kind: 'agent',
          sessionId: turn.sessionId,
          personaId: se0.personaId,
          handle: se0.handle,
          turnId: turn.id,
          text: '',
          status: 'streaming',
          activity: turn.first ? null : { steps: [...turn.steps] },
          // A reply to a lint message isn’t linted again, by the turn or by the browser’s diagram check.
          ...(turn.kind === 'lint' ? { lintReply: true } : {}),
        });
        // The text before a tool call or a block is finished; only the newest segment shows the caret.
        if (turn.lastSegment) rt.patchItem(turn.threadId, turn.lastSegment, { status: 'done' });
        turn.segment = it.id;
        turn.lastSegment = it.id;
        if (!turn.first) turn.first = it.id;
        if (turn.said) turn.said += '\n\n';
        rt.putThread({ ...rt.s.threads[turn.threadId], lastSpeaker: turn.sessionId });
      }
      return turn.segment;
    };
    const tools = this.toolsFor(turn.sessionId, turn);
    const thread = rt.s.threads[turn.threadId];
    const persona = rt.personaFor(se0);
    return {
      signal: turn.abort.signal,
      mcpUrl: `${this.config.origin}/mcp?session=${encodeURIComponent(turn.sessionId)}`,
      persona,
      project: rt.s.projects[thread?.projectId] ?? null,
      thread: { id: turn.threadId, title: thread?.title ?? '' },
      handles: rt.handles(),
      /** What the adapter saved for this session last time, such as its own session id. */
      state: { ...(se0.backendState ?? {}) },
      saveState(patch) {
        const s = se();
        if (s) rt.updateSession(s.id, { backendState: { ...(s.backendState ?? {}), ...patch } });
      },
      /** Where an attachment can be read on disk, or null. */
      pathOf: (a) => rt.attachmentPath(turn.threadId, a),
      /** Asks the person in the thread; resolves to { allow, message? }. */
      askPermission: (req) => rt.requestPermission(turn.sessionId, req),
      /** Permission rules the person allowed for this turn only, after a refusal (Claude Code rule syntax). */
      allowOnce: [...turn.allowOnce],
      /** The backend refused a tool call without asking: { toolUseId, tool, input, label, reason, reasonType, who }. */
      denied(d) {
        if (!live()) return;
        rt.recordDenial(turn, d);
      },
      /**
       * Where this turn ends in the backend’s own transcript, such as { claudeSessionId, uuid }. A topic
       * thread that branches from this turn’s messages forks the agent’s session there.
       */
      checkpoint(ref) {
        turn.checkpoint = ref;
      },
      text(delta) {
        if (!live() || !delta) return;
        const id = ensureSegment();
        turn.said += delta;
        rt.store.emit('item.text', { threadId: turn.threadId, id, text: delta });
        if (se().state !== 'gen') rt.updateSession(turn.sessionId, { state: 'gen', currentStep: 'Writing a reply' });
      },
      // who: the subagent that took the step; detail: why it failed, or the whole thought; kind: 'thought'.
      activity({ id, label, state = 'running', ms = null, who = null, detail = null, kind = null }) {
        if (!live()) return;
        // A lint turn that only calls tools (define_term, say) is quiet: it ends as a one-line note, not a reply.
        if (!turn.first && turn.kind !== 'lint') ensureSegment();
        const i = turn.steps.findIndex((s) => s.id === id);
        const step = {
          id: id ?? newId('st'),
          label: String(label).slice(0, 200),
          state: STEP_STATES.has(state) ? state : 'done',
          ms,
          ...(who ? { who: String(who).slice(0, 40) } : {}),
          ...(detail ? { detail: String(detail).slice(0, 1200) } : {}),
          ...(kind === 'thought' ? { kind } : {}),
        };
        if (i >= 0) turn.steps[i] = { ...turn.steps[i], ...step };
        else turn.steps.push(step);
        if (turn.first) rt.patchItem(turn.threadId, turn.first, { activity: { steps: [...turn.steps] } });
        const s = se();
        // A thought is in the list, but it isn’t a tool call.
        if (kind === 'thought') return;
        const calls = [{ name: step.label, state: step.state, ms: step.ms }, ...s.toolCalls.filter((c) => c.name !== step.label)].slice(0, 5);
        rt.updateSession(turn.sessionId, {
          state: state === 'running' ? 'tool' : s.state,
          toolCalls: calls,
          toolCount: s.toolCount + (i >= 0 ? 0 : 1),
          currentStep: state === 'running' ? step.label : s.currentStep,
        });
      },
      status(patch) {
        if (!live()) return;
        const allowed = {};
        if (patch.state && ['think', 'gen', 'tool'].includes(patch.state)) allowed.state = patch.state;
        if (typeof patch.ctx === 'number') allowed.ctx = Math.max(0, Math.min(100, Math.round(patch.ctx)));
        if (Array.isArray(patch.subagents))
          allowed.subagents = patch.subagents.slice(0, 12).map((x) => ({
            name: String(x.name).slice(0, 40),
            state: x.state,
            ctx: Math.max(0, Math.min(100, +x.ctx || 0)),
            doing: x.doing ? String(x.doing).slice(0, 120) : '',
          }));
        if (typeof patch.currentStep === 'string') allowed.currentStep = patch.currentStep.slice(0, 200);
        // A line of what it’s thinking or writing right now; cleared when the turn ends.
        if (typeof patch.glimpse === 'string') allowed.glimpse = patch.glimpse.slice(0, 200);
        rt.updateSession(turn.sessionId, allowed);
      },
      compaction({ kept, total, summary }) {
        if (!live()) return;
        const n = se().compactions + 1;
        turn.segment = null;
        rt.addItem(turn.threadId, {
          kind: 'system',
          variant: 'compaction',
          handle: se0.handle,
          n,
          kept,
          total,
          summary: String(summary ?? '').slice(0, 20000),
        });
        rt.updateSession(turn.sessionId, { compactions: n, ctx: Math.round((kept / total) * 100) });
      },
      sources(list) {
        if (!live()) return;
        const id = ensureSegment();
        rt.patchItem(turn.threadId, id, {
          sources: list.slice(0, 50).map((x) => ({
            title: String(x.title ?? ''),
            authors: String(x.authors ?? ''),
            year: x.year ?? null,
            url: x.url ?? null,
            note: x.note ? String(x.note) : '',
          })),
        });
      },
      tools,
    };
  }

  endTurn(turn, err) {
    if (turn.closed) return;
    turn.closed = true;
    this.turns.delete(turn.sessionId);
    for (const [id, w] of this.permissionWaits) if (w.sessionId === turn.sessionId) this.settlePermission(id, 'expired');
    // The turn’s own lines in an attached session’s transcript aren’t terminal activity.
    this.mirrors.get(turn.sessionId)?.tail.skipToEnd();
    const se = this.s.sessions[turn.sessionId];
    if (!se) return;
    const items = this.store.items(turn.threadId);
    for (const it of items)
      if (it.turnId === turn.id && it.kind === 'agent' && it.status === 'streaming') this.patchItem(turn.threadId, it.id, { status: err ? 'failed' : 'done' });
    if (turn.checkpoint && !err)
      for (const it of items)
        if (it.turnId === turn.id && (it.kind === 'agent' || it.kind === 'block')) this.patchItem(turn.threadId, it.id, { checkpoint: turn.checkpoint });
    // “Summarize back”: the reply goes to the conversation the topic branched from.
    if (turn.summarizeTo && !err && turn.said.trim())
      this.shareText(turn.summarizeTo, { fromThreadId: turn.threadId, handle: se.handle, text: turn.said, summary: true });
    if (err && err.name !== 'AbortError') {
      const message = err.userMessage ?? err.message ?? 'The agent stopped unexpectedly.';
      const target =
        turn.segment ??
        turn.first ??
        this.addItem(turn.threadId, {
          kind: 'agent',
          sessionId: se.id,
          personaId: se.personaId,
          handle: se.handle,
          turnId: turn.id,
          text: '',
          status: 'failed',
        }).id;
      this.patchItem(turn.threadId, target, { status: 'failed', error: message, retry: turn.retry ?? null });
      this.updateSession(se.id, {
        state: 'failed',
        needs: { kind: 'failed', itemId: target, text: message },
        subagents: [],
        currentStep: 'Failed',
        finishedAt: Date.now(),
      });
      this.notify('blocking', se, `@${se.handle}’s reply failed`, message);
      return;
    }
    // An app-check turn that ended without a new version: show the app with a note instead of waiting forever.
    if (turn.kind === 'app-check') {
      for (const app of Object.values(this.s.apps))
        if (app.sessionId === se.id && app.check.status === 'fixing') this.store.emit('app', { ...app, check: { ...app.check, status: 'note' } });
    }
    const open = items.filter((it) => it.kind === 'block' && it.sessionId === se.id && it.valid && ASKING.has(it.block.type) && !it.answered);
    const last = [...items].reverse().find((it) => it.kind === 'agent' && it.sessionId === se.id && it.text);
    const viewing = this.isViewing(turn.threadId);
    const refused = items.filter((it) => it.kind === 'denial' && it.turnId === turn.id && it.status === 'open');
    const needs = open.length
      ? { kind: 'block', itemId: open.at(-1).id, text: open.at(-1).block.title ?? clip(open.at(-1).block.prompt ?? open.at(-1).block.fallback, 120) }
      : refused.length
        ? {
            kind: 'denial',
            itemId: refused.at(-1).id,
            text: `${refused.length === 1 ? 'A step was' : `${refused.length} steps were`} refused: ${refused.at(-1).summary}`,
          }
        : se.needs?.kind === 'hop'
          ? se.needs
          : null;
    const mentionsYou = /(^|\W)@you\b/i.test(turn.said);
    this.updateSession(se.id, {
      state: needs ? 'needs' : 'idle',
      needs,
      glimpse: '',
      subagents: [],
      currentStep: needs ? 'Waiting for you' : `Idle since ${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })}`,
      lastMessage: last ? clip(last.text) : se.lastMessage,
      finishedAt: Date.now(),
      unread: viewing ? 0 : se.unread + (turn.said || open.length ? 1 : 0),
    });
    if (needs && (needs.kind === 'block' || needs.kind === 'denial')) this.notify('blocking', se, `@${se.handle} needs you`, needs.text);
    else if (mentionsYou && !viewing) this.notify('info', se, `@${se.handle} mentioned you`, clip(turn.said, 120));
    else if (turn.said && !viewing) this.notify('info', se, `@${se.handle} finished`, clip(turn.said, 120));

    // The checks: what this turn sent, as problems, which go back to the agent in one lint turn. A lint turn is
    // never linted again, so this can’t loop; one that only called tools ends as a note instead of a reply.
    const stalled = this.stallSteps(turn, se);
    if (turn.kind === 'lint') this.quietLint(turn, se);
    else this.endLint(turn, [...this.checkTurn(turn, se), ...stalled]);

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
      this.deliver(se.id, next.message, { replyTo: next.replyTo, summarizeTo: next.summarizeTo });
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
    // A tool call waiting for your permission is answered no, so the agent’s process can stop too.
    for (const [id, w] of this.permissionWaits) if (w.sessionId === sessionId) this.settlePermission(id, 'expired', 'You stopped the agent.');
    for (const it of this.store.items(turn.threadId)) {
      if (it.turnId === turn.id && it.kind === 'agent' && it.status === 'streaming')
        this.patchItem(turn.threadId, it.id, { status: 'stopped', stoppedAt: Date.now() });
    }
    if (!turn.segment && !turn.first) {
      this.addItem(turn.threadId, {
        kind: 'agent',
        sessionId,
        personaId: this.s.sessions[sessionId].personaId,
        handle: this.s.sessions[sessionId].handle,
        turnId: turn.id,
        text: '',
        status: 'stopped',
        stoppedAt: Date.now(),
      });
    }
    this.updateSession(sessionId, { state: 'idle', subagents: [], currentStep: 'Stopped by you', finishedAt: Date.now() });
    if (!silent) this.drainQueue(turn.threadId);
    return true;
  }

  /** Retry a failed reply: sends the same message again. */
  retry(threadId, itemId) {
    const it = this.store.item(threadId, itemId);
    if (it?.status !== 'failed') throw httpError(409, 'Only a failed reply can be retried.');
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
    const parent = t.kind === 'side' ? (this.s.threads[t.parentId] ?? t) : t;
    if (!confirmed && (parent.hops ?? 0) >= HOP_LIMIT) {
      // One request at a time: further wakes wait behind the one you haven’t answered.
      if (this.store.items(parent.id).some((x) => x.kind === 'hop' && x.status === 'open'))
        return { ok: false, waiting: true, message: 'Another wake is already waiting for the person to allow it.' };
      const it = this.addItem(parent.id, {
        kind: 'hop',
        fromSessionId,
        from: from.handle,
        to: p.handle,
        reason: clip(text, 200),
        status: 'open',
        n: (parent.hops ?? 0) + 1,
      });
      this.updateSession(fromSessionId, {
        needs: { kind: 'hop', itemId: it.id, text: `@${from.handle} wants to wake @${p.handle}` },
        state: this.turns.has(fromSessionId) ? from.state : 'needs',
      });
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
      side = this.putThread({
        id: newId('th'),
        projectId: parent.projectId,
        title: `@${from.handle} ↔ @${p.handle}`,
        kind: 'side',
        parentId: parent.id,
        pair,
        members: [],
        lastSpeaker: null,
        hops: 0,
        queue: [],
        createdAt: Date.now(),
        archived: false,
      });
      this.addItem(parent.id, { kind: 'sidelink', sideThreadId: side.id, from: from.handle, to: p.handle, count: 0 });
    }
    const said = this.addItem(side.id, { kind: 'agent', sessionId: from.id, personaId: from.personaId, handle: from.handle, text, status: 'done' });
    this.recordAgentMessage(from.id, 'to', p.handle, text);
    const target = this.ensureSession(side.id, p.id);
    this.recordAgentMessage(target.id, 'from', from.handle, text);
    this.bumpSideLink(side.id);
    this.deliver(target.id, { kind: 'agent', from: `@${from.handle}`, text, itemId: said.id }, { replyTo: from.id });
    return { ok: true, message: `Woke @${p.handle}.` };
  }

  resolveHop(threadId, itemId, allow) {
    const it = this.store.item(threadId, itemId);
    if (it?.kind !== 'hop' || it.status !== 'open') throw httpError(409, 'That request was already answered.');
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
    if (it.kind === 'proposal') return this.resolveProposal(threadId, itemId, action);
    if (it.kind === 'permission') return this.resolvePermission(threadId, itemId, action);
    if (it.kind === 'denial') return this.resolveDenial(threadId, itemId, action);
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
    // A proposed teammate runs where its proposer runs, with the default permissions and model.
    const proposer = this.s.sessions[it.sessionId];
    const backend = (proposer && this.persona(proposer.personaId)?.backend) ?? 'mock';
    const { handle, description, instructions, tools } = it.proposal;
    const p = this.createPersona({ handle, description, instructions, tools, backend, createdBy: it.sessionId });
    this.patchItem(threadId, itemId, { status: 'created', personaId: p.id });
    this.addItem(threadId, { kind: 'voice', text: `Created @${p.handle}` });
    this.ensureSession(threadId, p.id, { brief: it.proposal.description });
    this.addItem(threadId, { kind: 'system', variant: 'joined', to: p.handle });
    return { ok: true, personaId: p.id };
  }

  // ── Topic threads ──────────────────────────────────────────────────────────────────
  // Any message in a conversation can start a topic thread, as in Slack. Its agent is a fork of the agent’s
  // session at that message: it remembers everything up to it and nothing after, and the conversation never
  // sees the thread unless you send something back. That keeps a side topic out of the main session’s
  // context, which is the point: conversations are how you manage what each agent remembers.

  startTopic(threadId, itemId) {
    const parent = this.thread(threadId);
    if (parent.kind === 'topic' || parent.kind === 'side') throw httpError(409, 'A topic thread can’t start another one. Reply in this one instead.');
    const items = this.store.items(threadId);
    const idx = items.findIndex((x) => x.id === itemId);
    const root = items[idx];
    if (!root || !['user', 'agent', 'block', 'shared'].includes(root.kind)) throw httpError(404, 'That message can’t start a thread.');
    if (root.topicId && this.s.threads[root.topicId]) return { threadId: root.topicId };
    const topic = this.putThread({
      id: newId('th'),
      projectId: parent.projectId,
      // Named after the message’s first line, which is its heading when it has one.
      title: clip((root.text ?? '').split('\n').find((l) => l.trim()) || root.block?.title || root.block?.fallback || 'Thread', 60),
      kind: 'topic',
      parentId: threadId,
      rootItemId: itemId,
      members: [],
      lastSpeaker: null,
      hops: 0,
      queue: [],
      createdAt: Date.now(),
      archived: false,
    });
    this.patchItem(threadId, itemId, { topicId: topic.id, replies: 0 });
    // Who comes along: the agent that wrote the message, or for yours, the agent that answered it.
    const answer = items.slice(idx + 1).find((x) => x.sessionId && (x.kind === 'agent' || x.kind === 'block'));
    const members = this.sessionsIn(threadId).filter((x) => !x.archived);
    const src =
      (root.sessionId && this.s.sessions[root.sessionId]) ||
      (answer && this.s.sessions[answer.sessionId]) ||
      members.find((x) => x.id === parent.lastSpeaker) ||
      members[0];
    if (src) this.forkSession(src.id, topic.id);
    return { threadId: topic.id };
  }

  /**
   * Adds a fork of a conversation’s session to one of its topic threads. The fork point is the agent’s last
   * finished turn at or before the topic’s root message; the adapter resumes the backend session there.
   */
  forkSession(sourceSessionId, topicId) {
    const src = this.session(sourceSessionId);
    const topic = this.thread(topicId);
    const items = this.store.items(topic.parentId);
    const idx = items.findIndex((x) => x.id === topic.rootItemId);
    const at = items
      .slice(0, idx + 1)
      .reverse()
      .find((x) => x.sessionId === src.id && x.checkpoint);
    const se = this.ensureSession(topicId, src.personaId);
    const root = items[idx];
    const who = root?.kind === 'user' ? 'your' : root?.handle ? `@${root.handle}’s` : 'a';
    this.updateSession(se.id, {
      // The same persona version as the session it forks: it is the same agent, branching.
      personaSnapshot: src.personaSnapshot,
      forkOf: { sessionId: src.id, itemId: at?.id ?? null },
      // With no checkpoint before the root, an agent that joined later starts fresh; replies from before
      // checkpoints were kept fall back to the session’s latest point.
      backendState: {
        fork: at?.checkpoint ?? null,
        forkFrom: at || items.some((x) => x.sessionId === src.id && x.checkpoint) ? null : (src.backendState ?? null),
        contextWindow: src.backendState?.contextWindow,
      },
      ctx: src.ctx,
      compactions: src.compactions,
      context: [
        `[Postbox] This is a topic thread that branches from ${who} message in the conversation “${this.s.threads[topic.parentId]?.title ?? ''}”: “${clip(root?.text || root?.block?.title || '', 400)}”. You remember the conversation up to there. It continues separately, and nothing from this thread reaches it unless the person sends it back.`,
      ],
    });
    this.adapters.get(this.persona(src.personaId)?.backend ?? 'mock').fork?.(src, this.s.sessions[se.id]);
    return this.s.sessions[se.id];
  }

  /** “Send to conversation”: a reply from a topic thread is posted in its conversation, for you and its agents. */
  shareToConversation(topicId, itemId) {
    const topic = this.thread(topicId);
    if (topic.kind !== 'topic') throw httpError(409, 'Only replies in a topic thread can be sent to the conversation.');
    const it = this.store.item(topicId, itemId);
    if (!it?.text) throw httpError(404, 'That reply has no text to send.');
    if (it.sharedAt) throw httpError(409, 'That reply is already in the conversation.');
    this.patchItem(topicId, itemId, { sharedAt: Date.now() });
    return this.shareText(topic.parentId, { fromThreadId: topicId, handle: it.kind === 'user' ? null : it.handle, text: it.text });
  }

  /** “Summarize back”: the topic’s agent writes a short summary, which is posted in the conversation. */
  summarizeBack(topicId) {
    const topic = this.thread(topicId);
    if (topic.kind !== 'topic') throw httpError(409, 'Only a topic thread can be summarized back.');
    const se = this.sessionsIn(topicId).find((x) => !x.archived);
    if (!se) throw httpError(409, 'No agent is in this thread to summarize it.');
    this.addItem(topicId, { kind: 'voice', text: 'Asked for a summary to send back to the conversation' });
    this.deliver(
      se.id,
      {
        kind: 'notice',
        text: 'Summarize this topic thread for the main conversation: what was decided, what changed, and anything still open. One short paragraph, no headings. It will be posted there as your summary.',
      },
      { summarizeTo: topic.parentId },
    );
    return { ok: true };
  }

  /**
   * Posts text from a topic thread in its conversation. The conversation’s agents read it at the start of
   * their next turn rather than being woken by it, so sharing never costs a turn.
   */
  shareText(threadId, { fromThreadId, handle, text, summary = false }) {
    const from = this.s.threads[fromThreadId];
    // The conversation’s agents read it at the start of their next turn, with everything else they missed.
    const it = this.addItem(threadId, { kind: 'shared', fromThreadId, fromTitle: from?.title ?? '', handle, text, summary });
    return it;
  }

  // ── Shared memory in a conversation ────────────────────────────────────────────────
  // Every agent in a conversation can read all of it. Each session keeps a marker of the last item it was given;
  // a delivery starts with what came after it, from you and from the other agents, and an agent joining later
  // gets the recent history the same way. read_conversation reads further back.

  /** The catch-up text for a session, or null, and moves its marker to the end of the conversation. */
  catchUp(se, excludeId = null) {
    if (!se) return null;
    const items = this.store.items(se.threadId);
    const t = this.s.threads[se.threadId];
    const at = se.seenItem ? items.findIndex((i) => i.id === se.seenItem) : -1;
    this.updateSession(se.id, { seenItem: items.at(-1)?.id ?? null });
    // A session from before markers were kept, alone in its conversation, already saw everything addressed to it.
    if (se.seenItem === undefined && (t?.members?.length ?? 0) <= 1 && se.startedAt < (items.at(-1)?.at ?? 0)) return null;
    const lines = items
      .slice(at + 1)
      .filter((i) => i.id !== excludeId && i.sessionId !== se.id)
      .map((i) => this.describeItem(i, se))
      .filter(Boolean);
    if (!lines.length) return null;
    const kept = [];
    let size = 0;
    for (const line of lines.reverse()) {
      if (kept.length >= CATCH_UP_ITEMS || size + line.length > CATCH_UP_CHARS) break;
      kept.unshift(line);
      size += line.length;
    }
    const dropped = lines.length - kept.length;
    const where = t?.kind === 'room' ? 'this room' : t?.kind === 'topic' ? 'this thread' : 'this conversation';
    return `[Postbox] What happened in ${where} since your last turn${dropped ? ` (the last ${kept.length}; ${dropped} earlier ${dropped === 1 ? 'item is' : 'items are'} left out, and read_conversation has them)` : ''}:\n\n${kept.join('\n\n')}`;
  }

  /**
   * One conversation item as a line an agent can read, from the point of view of `se`; null to leave it out.
   * @param {any} i @param {any} [se]
   */
  describeItem(i, se = null) {
    const text = (s) => clipText(String(s ?? ''), 2000);
    switch (i.kind) {
      case 'user':
        return `You: ${text(i.text)}${i.attachments?.length ? ` [attached: ${i.attachments.map((a) => a.name ?? a.path).join(', ')}]` : ''}`;
      case 'agent':
        return i.text && i.status !== 'failed' ? `@${i.handle}: ${text(i.text)}` : null;
      case 'block':
        return i.valid
          ? `@${i.handle} showed ${i.block.type === 'app' ? 'an app' : `a ${i.block.type} block`} “${text(i.block.title ?? i.block.fallback)}”`
          : null;
      case 'voice': {
        // The agent hears about its own blocks as events already.
        const block = i.blockItemId && this.store.item(se?.threadId, i.blockItemId);
        return block && block.sessionId === se?.id ? null : `You: ${text(i.text)}`;
      }
      case 'shared':
        return `${i.summary ? 'Summary' : 'Shared'} from the thread “${i.fromTitle}”${i.handle ? `, by @${i.handle}` : ', by the person'}: ${text(i.text)}`;
      case 'system':
        if (i.variant === 'wake') return `${i.from === 'you' ? 'You' : `@${i.from}`} woke @${i.to}`;
        if (i.variant === 'joined') return `@${i.to} joined`;
        if (i.variant === 'left') return `@${i.to} left`;
        return null;
      case 'sidelink':
        return `@${i.from} and @${i.to} talked in a side thread (${i.count ?? 0} messages)`;
      case 'proposal':
        return `@${i.handle} proposed a new teammate, @${i.proposal?.handle}`;
      default:
        return null;
    }
  }

  /** read_conversation: the conversation’s items, newest last, as text. */
  readConversation(se, { limit = 50, skip = 0 } = {}) {
    const items = this.store.items(se.threadId).filter((i) => i.kind !== 'system' || i.variant === 'wake');
    const n = Math.max(1, Math.min(200, Number(limit) || 50));
    const end = Math.max(0, items.length - Math.max(0, Number(skip) || 0));
    const slice = items.slice(Math.max(0, end - n), end);
    const lines = slice
      .map((i) => (i.sessionId === se.id && i.kind === 'agent' ? `You (@${se.handle}): ${clipText(i.text ?? '', 2000)}` : this.describeItem(i)))
      .filter(Boolean);
    const before = end - slice.length;
    return `${lines.join('\n\n') || 'The conversation is empty.'}${before ? `\n\n(${before} earlier ${before === 1 ? 'item' : 'items'}; call again with skip: ${items.length - before} to read them.)` : ''}`;
  }

  // ── The lint pipeline ──────────────────────────────────────────────────────────────
  // Every check returns problems, { code, message, scope } (server/checks.mjs). The problems an agent turn caused
  // go back to the agent as one lint turn: the server’s checks run when the turn ends, and the browser reports what
  // it measures (diagrams, the app check) as the reply renders, so the lint turn waits a moment for those. There’s
  // at most one lint turn per agent turn, a lint turn is never linted, and problems from a turn that failed or was
  // stopped are dropped.

  /** A thread, then the conversation it branched from, following parentId (a topic or side thread’s is one level). */
  lineage(threadId) {
    const out = [];
    for (let id = threadId; id && this.s.threads[id] && !out.includes(id) && out.length < 8; id = this.s.threads[id].parentId) out.push(id);
    return out;
  }

  /**
   * The terms a thread knows: its own glossary over its parent’s, so a topic thread inherits its conversation’s
   * terms and its own definition wins. The browser’s glossaryOf (app/js/thread.mjs) merges the same way.
   */
  glossaryFor(threadId) {
    return Object.assign(
      {},
      ...this.lineage(threadId)
        .map((id) => this.s.glossary[id] ?? {})
        .reverse(),
    );
  }

  /** The server’s checks over a finished turn. */
  checkTurn(turn, se) {
    const lineage = this.lineage(turn.threadId);
    const items = lineage.flatMap((id) => this.store.items(id));
    const apps = Object.values(this.s.apps).filter((a) => lineage.includes(a.threadId));
    const problems = termProblems(turn.said, this.glossaryFor(turn.threadId), introducedTerms(items, apps));
    // Diagrams too wide or too busy to read at the conversation’s width.
    const diagrams = lintDiagrams(turn.said);
    if (diagrams.length)
      this.rememberDiagrams(
        se.id,
        diagrams.map((d) => d.src),
      );
    problems.push(...diagramProblems(diagrams));
    return problems;
  }

  /** Progress steps still running when their agent’s turn ends are marked stalled, and the agent is told to close them. */
  stallSteps(turn, se) {
    const problems = [];
    for (const it of this.store.items(turn.threadId)) {
      if (it.kind !== 'block' || !it.valid || it.sessionId !== se.id || it.block.type !== 'progress') continue;
      const running = it.block.steps.filter((s) => s.state === 'running');
      if (!running.length) continue;
      const steps = it.block.steps.map((s) => (s.state === 'running' ? { ...s, state: 'stalled' } : s));
      this.patchItem(turn.threadId, it.id, { block: { ...it.block, steps }, stalledAt: Date.now() });
      const names = running.map((s) => `“${s.label}”`);
      const one = running.length === 1;
      problems.push({
        code: 'steps-left-running',
        message: `${one ? 'Step' : 'Steps'} ${names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]} ${one ? 'was' : 'were'} still running when your turn ended, so the person sees ${one ? 'it' : 'them'} as stalled. Close each with update_block, as done or failed. If the work goes on in the background, set it back to running and update it as it moves.`,
        scope: { kind: 'block', id: it.block.id, title: it.block.title },
      });
    }
    return problems;
  }

  lintEntry(sessionId, turnId) {
    let e = this.lints.get(turnId);
    if (!e) {
      e = { sessionId, kind: null, ended: false, sent: false, problems: [], timer: null };
      this.lints.set(turnId, e);
      // Only recent turns can still get a lint turn.
      for (const [k, old] of this.lints) {
        if (this.lints.size <= 200) break;
        clearTimeout(old.timer);
        this.lints.delete(k);
      }
    }
    return e;
  }

  /** The turn ended: its lint turn goes once the browser has had a moment to report. */
  endLint(turn, problems) {
    const e = this.lintEntry(turn.sessionId, turn.id);
    e.kind = turn.kind;
    e.ended = true;
    e.problems.push(...problems);
    if (e.problems.length) this.sendLint(turn.id);
  }

  /**
   * Adds problems to the lint turn of the agent turn they came from. Returns whether the agent will hear of them:
   * not when they came from a lint turn, or when that turn’s lint turn has already gone.
   * @param {string} sessionId  @param {string|null|undefined} turnId  @param {import('./checks.mjs').Problem[]} problems
   */
  lint(sessionId, turnId, problems) {
    if (!problems.length || !turnId || !this.s.sessions[sessionId]) return false;
    const live = [...this.turns.values()].some((t) => t.id === turnId);
    const e = this.lintEntry(sessionId, turnId);
    // A turn that isn’t running and didn’t end well failed or was stopped, or ran before a restart.
    if (!live && e.kind === null) {
      const threadId = this.s.sessions[sessionId].threadId;
      e.ended = true;
      e.sent = this.store.items(threadId).some((i) => i.turnId === turnId && (i.status === 'failed' || i.status === 'stopped'));
    }
    if (e.kind === 'lint' || e.sent) return false;
    e.problems.push(...problems);
    if (e.ended) this.sendLint(turnId);
    return true;
  }

  sendLint(turnId) {
    const e = this.lints.get(turnId);
    if (!e || e.sent || e.timer) return;
    const wait = this.config.lintSettleMs ?? LINT_SETTLE_MS;
    const until = Date.now() + LINT_WAIT_MAX_MS;
    const send = () => {
      e.timer = null;
      // An app this agent showed is still being checked in the browser: its warnings join this lint turn.
      const checking = Object.values(this.s.apps).some((a) => a.sessionId === e.sessionId && a.check.status === 'pending');
      if (wait > 0 && checking && Date.now() < until) {
        e.timer = setTimeout(send, wait);
        e.timer.unref?.();
        return;
      }
      e.sent = true;
      const se = this.s.sessions[e.sessionId];
      if (se && !se.deleting && !se.archived) this.deliver(e.sessionId, lintMessage(e.problems));
    };
    if (wait <= 0) return send();
    e.timer = setTimeout(send, wait);
    e.timer.unref?.();
  }

  /**
   * Another turn starts before a lint turn went (the person wrote during the settle, say): the problems join that
   * turn, so a lint turn never lands after it, and later reports for the earlier turns are dropped.
   */
  foldLint(sessionId, message) {
    const problems = [];
    for (const e of this.lints.values()) {
      if (e.sessionId !== sessionId || !e.ended || e.sent) continue;
      clearTimeout(e.timer);
      e.timer = null;
      e.sent = true;
      problems.push(...e.problems);
    }
    return problems.length ? { ...message, context: [formatLint(lintMessage(problems), { folded: true }), ...(message.context ?? [])] } : message;
  }

  /** A lint turn that wrote nothing shows as one line, such as “@researcher defined “Step 2””. */
  quietLint(turn, se) {
    if (turn.said.trim() || turn.first) return;
    const defined = [...new Set(turn.defined ?? [])].map((t) => `“${t}”`);
    const list = defined.length > 1 ? `${defined.slice(0, -1).join(', ')} and ${defined.at(-1)}` : (defined[0] ?? '');
    const text = defined.length ? `@${se.handle} defined ${list}` : turn.steps.length ? `@${se.handle} acted on Postbox’s check without a reply` : null;
    if (text) this.addItem(turn.threadId, { kind: 'system', variant: 'lint', handle: se.handle, turnId: turn.id, text, lintReply: true });
  }

  // The diagram linter estimates from a diagram’s source; the browser measures the real text size after it renders
  // and reports here what the estimate missed. Either way the agent hears about a diagram once.

  rememberDiagrams(sessionId, sources) {
    const se = this.s.sessions[sessionId];
    if (!se) return;
    const hashes = sources.map((s) => createHash('sha256').update(s.trim()).digest('hex').slice(0, 16));
    this.updateSession(sessionId, { diagramsLinted: [...new Set([...(se.diagramsLinted ?? []), ...hashes])].slice(-50) });
  }

  /**
   * The browser drew a diagram: { src, textPx, width } when it measured it, or { src, error: { message, line } }
   * when Mermaid couldn’t draw it.
   */
  diagramCheck(threadId, itemId, { src, textPx, width, error }) {
    const it = this.store.item(threadId, itemId);
    if (it?.kind !== 'agent' || it.lintReply || typeof src !== 'string') return { ok: true, sent: false };
    const se = this.s.sessions[it.sessionId];
    const failed = error && typeof error === 'object' && typeof error.message === 'string';
    // Only a measurement at the conversation’s width counts; a narrow panel or phone shrinks every diagram.
    if (!se || (!failed && (!(textPx < MIN_TEXT_PX) || !(width >= COLUMN_PX * 0.8)))) return { ok: true, sent: false };
    const hash = createHash('sha256').update(src.trim()).digest('hex').slice(0, 16);
    if (se.diagramsLinted?.includes(hash)) return { ok: true, sent: false };
    const blocks = mermaidBlocks(String(it.text));
    const index = blocks.find((b) => b.src.trim() === src.trim())?.index ?? (blocks.length > 1 ? null : 0);
    const scope = { kind: 'diagram', index, excerpt: src.split('\n').slice(0, 3).join('\n') };
    let problem;
    if (failed) {
      // Mermaid’s message, without its caret line: “Parse error on line 2: … Expecting 'SEMI', got 'ARROW'”.
      const said = error.message
        .split('\n')
        .filter((l) => l.trim() && !/^[-\s]*\^$/.test(l))
        .join(' ')
        .slice(0, 400);
      const line = Number.isInteger(error.line) && error.line > 0 ? ` (line ${Math.min(error.line, 9999)})` : '';
      problem = {
        code: 'diagram-error',
        message: `Mermaid couldn’t draw it, so the person sees an error and its source instead. Mermaid said${line}: “${said}”. Fix the syntax.`,
        scope,
      };
    } else
      problem = {
        code: 'text-too-small',
        message: `In the person’s browser, its text is drawn at ${Math.round(textPx * 10) / 10} px at a width of ${Math.round(width)} px, too small to read. Draw it top to bottom, split it, or shorten its labels.`,
        scope,
      };
    const sent = this.lint(se.id, it.turnId, [problem]);
    if (sent) this.rememberDiagrams(se.id, [src]);
    return { ok: true, sent };
  }

  // ── Permission prompts ─────────────────────────────────────────────────────────────
  // A real agent in “ask” mode stops before anything risky, such as running a command. Postbox shows a card
  // in the thread, the agent needs you, and the tool call waits for your answer. Ending the turn, or Stop,
  // turns any open card into “expired” and answers no.

  /**
   * @param {string} sessionId
   * @param {{ tool: string, summary: string, detail?: string, toolUseId?: string|null }} req
   * @returns {Promise<{ allow: boolean, message?: string }>}
   */
  requestPermission(sessionId, { tool, summary, detail = '', toolUseId = null }) {
    const se = this.s.sessions[sessionId];
    const turn = this.turns.get(sessionId);
    if (!se || !turn) return Promise.resolve({ allow: false, message: 'The turn has ended.' });
    const it = this.addItem(se.threadId, {
      kind: 'permission',
      sessionId,
      handle: se.handle,
      turnId: turn.id,
      tool: String(tool).slice(0, 120),
      summary: String(summary).slice(0, 200),
      detail: String(detail).slice(0, 4000),
      // The tool call it’s about, so a refusal of a call you answered here doesn’t get a second card.
      toolUseId: toolUseId ? String(toolUseId) : null,
      status: 'open',
    });
    // The text so far is finished; the reply continues below the card.
    if (turn.segment) this.patchItem(se.threadId, turn.segment, { status: 'done' });
    turn.segment = null;
    this.updateSession(sessionId, { state: 'needs', needs: { kind: 'permission', itemId: it.id, text: `@${se.handle} asks to ${it.summary}` } });
    this.notify('blocking', se, `@${se.handle} asks permission`, `To ${it.summary}.`);
    return new Promise((resolve) => {
      this.permissionWaits.set(it.id, { resolve, threadId: se.threadId, sessionId });
    });
  }

  settlePermission(itemId, status, message) {
    const w = this.permissionWaits.get(itemId);
    if (!w) return false;
    this.permissionWaits.delete(itemId);
    this.patchItem(w.threadId, itemId, { status, answeredAt: Date.now() });
    const se = this.s.sessions[w.sessionId];
    if (se?.needs?.itemId === itemId) this.updateSession(se.id, { needs: null, state: this.turns.has(se.id) ? 'tool' : 'idle' });
    w.resolve(status === 'allowed' ? { allow: true } : { allow: false, message: message ?? 'The request expired when the turn ended.' });
    return true;
  }

  resolvePermission(threadId, itemId, action) {
    const it = this.store.item(threadId, itemId);
    if (it?.kind !== 'permission' || it.status !== 'open' || !this.permissionWaits.has(itemId))
      throw httpError(409, 'That request was already answered, or the turn that asked has ended.');
    if (action !== 'allow' && action !== 'deny') throw httpError(400, 'A permission request takes “allow” or “deny”.');
    const allow = action === 'allow';
    this.addItem(threadId, { kind: 'voice', text: `${allow ? 'Allowed' : 'Didn’t allow'}: @${it.handle} to ${it.summary}` });
    this.settlePermission(itemId, allow ? 'allowed' : 'denied', 'The person didn’t allow this. Ask them what to do instead, or find another way.');
    return { ok: true };
  }

  // ── Refusals ───────────────────────────────────────────────────────────────────────
  // Claude Code refuses some calls without asking anyone: auto mode’s classifier, a deny rule, or the mode.
  // Each refusal becomes a card, so the person can allow it once (the agent tries again), always (a rule in
  // the agent folder’s .claude/settings.local.json, shared with the CLI), or leave it.

  recordDenial(turn, d) {
    const se = this.s.sessions[turn.sessionId];
    if (!se) return;
    const key = String(d.toolUseId ?? '');
    // Once per call, and never for a call the person answered on a permission card.
    if (key && this.store.items(turn.threadId).some((it) => (it.kind === 'denial' || it.kind === 'permission') && it.toolUseId === key)) return;
    const rules = rulesFor(String(d.tool ?? ''), d.input ?? {});
    const detail = d.tool === 'Bash' ? String(d.input?.command ?? '') : JSON.stringify(d.input ?? {}, null, 2);
    this.addItem(turn.threadId, {
      kind: 'denial',
      sessionId: se.id,
      handle: se.handle,
      turnId: turn.id,
      toolUseId: key,
      tool: String(d.tool ?? '').slice(0, 120),
      summary: String(d.label ?? d.tool ?? '').slice(0, 200),
      detail: detail.slice(0, 4000),
      reason: String(d.reason ?? '').slice(0, 400),
      reasonType: d.reasonType ? String(d.reasonType).slice(0, 40) : null,
      who: d.who ? String(d.who).slice(0, 40) : null,
      rules,
      status: 'open',
    });
    // The text so far is finished; the reply continues below the card.
    if (turn.segment) this.patchItem(se.threadId, turn.segment, { status: 'done' });
    turn.segment = null;
  }

  async resolveDenial(threadId, itemId, action) {
    const it = this.store.item(threadId, itemId);
    if (it?.kind !== 'denial' || it.status !== 'open') throw httpError(409, 'That refusal was already answered.');
    if (!['once', 'always', 'leave'].includes(action)) throw httpError(400, 'A refusal takes “once”, “always” or “leave”.');
    const se = this.s.sessions[it.sessionId];
    const asked = it.who ? `${it.who} (your subagent)` : 'you';
    /** @type {string | null} */
    let note = null;
    if (action === 'always') {
      const persona = se && this.personaFor(se);
      const adapter = persona && this.adapters.get(persona.backend);
      if (!adapter?.folderFor) throw httpError(409, 'Only Claude Code and Agent SDK agents read permission rules.');
      const folder = await adapter.folderFor(persona, this.s.projects[this.s.threads[threadId]?.projectId]);
      const { file } = await addAllowRule(folder, it.rules.always);
      note = `[Postbox] The person now always allows \`${it.rules.always}\` (saved in ${file}). The step ${asked} tried, ${it.summary}, was refused before: try it again, then carry on.`;
    } else if (action === 'once') {
      if (se) this.updateSession(se.id, { allowOnce: [...(se.allowOnce ?? []), it.rules.once] });
      note = `[Postbox] The person allowed \`${it.rules.once}\` for your next turn only. The step ${asked} tried, ${it.summary}, was refused before: try it again, then carry on.`;
    }
    const status = { once: 'allowed-once', always: 'allowed-always', leave: 'left' }[action];
    this.patchItem(threadId, itemId, { status, answeredAt: Date.now() });
    const words = { once: 'Allowed once', always: `Always allowed ${it.rules.alwaysWords}`, leave: 'Left refused' }[action];
    this.addItem(threadId, { kind: 'voice', text: `${words}: @${it.handle} to ${it.summary}` });
    if (se?.needs?.itemId === itemId) {
      const next = this.store.items(threadId).find((x) => x.kind === 'denial' && x.sessionId === se.id && x.status === 'open');
      this.updateSession(se.id, {
        needs: next ? { kind: 'denial', itemId: next.id, text: `A step was refused: ${next.summary}` } : null,
        state: this.turns.has(se.id) ? se.state : next ? 'needs' : 'idle',
      });
    }
    if (note && se && !se.archived) this.deliver(se.id, { kind: 'notice', text: note });
    return { ok: true };
  }

  /** After a restart, no tool call is waiting any more, so open cards can’t be answered. */
  expireStalePermissions() {
    for (const [threadId, items] of Object.entries(this.s.items))
      for (const it of items) if (it.kind === 'permission' && it.status === 'open') this.patchItem(threadId, it.id, { status: 'expired' });
  }

  /** Where an attachment can be read on disk: a stored upload, or a file in the project’s folder. */
  attachmentPath(threadId, a) {
    if (a?.kind === 'file' && a.fileId) {
      const f = this.s.files?.[a.fileId];
      return f?.sha256 && this.blobs ? this.blobs.pathOf(f.sha256) : null;
    }
    if (a?.kind === 'project-file' && a.path) {
      const folder = this.s.projects[this.s.threads[threadId]?.projectId]?.folder;
      if (!folder) return null;
      const full = resolve(folder, String(a.path).replace(/^\/+/, ''));
      return full === resolve(folder) || full.startsWith(resolve(folder) + sep) ? full : null;
    }
    return null;
  }

  // ── Attached Claude Code sessions ──────────────────────────────────────────────────
  // A session you started in a terminal can join Postbox: it becomes an agent whose folder is the session’s
  // folder, and Postbox resumes that same Claude Code session when you write to it. What you type in the
  // terminal is mirrored into the thread, marked “from terminal”. Lines written during Postbox’s own turns are
  // skipped, so nothing shows twice.

  async claudeSessions() {
    const attached = new Set(
      Object.values(this.s.sessions)
        .map((se) => se.backendState?.claudeSessionId)
        .filter(Boolean),
    );
    return (await listClaudeSessions({ root: this.config.claudeProjectsRoot })).map(({ file: _file, ...x }) => ({ ...x, attached: attached.has(x.id) }));
  }

  async attachClaudeSession({ claudeSessionId, projectId, handle }) {
    if (!this.adapters.names().includes('claude-code'))
      throw httpError(422, 'Claude Code isn’t available on this computer, so its sessions can’t be attached.');
    const cs = (await listClaudeSessions({ root: this.config.claudeProjectsRoot, limit: 500 })).find((x) => x.id === claudeSessionId);
    if (!cs) throw httpError(404, 'That Claude Code session wasn’t found. It may have been deleted.');
    if (!cs.cwd) throw httpError(422, 'That session doesn’t say which folder it ran in, so Postbox can’t resume it.');
    if (Object.values(this.s.sessions).some((se) => se.backendState?.claudeSessionId === claudeSessionId && !se.deleting))
      throw httpError(409, 'That session is already attached.');
    if (!this.s.projects[projectId]) throw httpError(404, 'That project doesn’t exist.');
    const base =
      String(handle || basename(cs.cwd))
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^[^a-z]+/, '')
        .slice(0, 20) || 'terminal';
    let name = base.length >= 2 ? base : `cc-${base}`;
    for (let n = 2; this.personaByHandle(name); n++) name = `${base.slice(0, 20)}-${n}`;
    const p = this.createPersona({
      handle: name,
      backend: 'claude-code',
      description: `Attached from Claude Code in ${cs.cwd}`,
      folder: cs.cwd,
    });
    const t = this.createThread({ projectId, title: cs.title, personaIds: [p.id] });
    const se = this.sessionsIn(t.id)[0];
    this.updateSession(se.id, { backendState: { claudeSessionId, transcript: cs.file, attached: true } });
    for (const it of recentHistory(cs.file)) {
      if (it.kind === 'user') this.addItem(t.id, { kind: 'user', text: it.text, via: 'terminal' });
      else
        this.addItem(t.id, {
          kind: 'agent',
          sessionId: se.id,
          personaId: p.id,
          handle: p.handle,
          text: it.text,
          status: 'done',
          via: 'terminal',
          activity: it.steps.length ? { steps: it.steps.map((s) => ({ ...s, state: s.state === 'running' ? 'done' : s.state })) } : null,
        });
    }
    this.addItem(t.id, { kind: 'system', variant: 'attached', handle: p.handle, folder: cs.cwd });
    this.mirror(se.id);
    return { threadId: t.id, personaId: p.id, sessionId: se.id };
  }

  /** Starts following an attached session’s transcript. */
  mirror(sessionId) {
    const se = this.s.sessions[sessionId];
    const file = se?.backendState?.transcript;
    if (!file || this.mirrors.has(sessionId)) return;
    const timer = setInterval(() => this.pollMirror(sessionId), 1500);
    timer.unref?.();
    this.mirrors.set(sessionId, { tail: new TranscriptTail(file), timer, agentItem: null, steps: [] });
  }

  /** Deletions whose Undo window was still open when the server stopped: finish them on time, or now if overdue. */
  rearmDeletions() {
    const wait = (until) => Math.max(0, until - Date.now());
    for (const se of Object.values(this.s.sessions))
      if (se.deleting) this.timers.set(`del:${se.id}`, setTimeout(() => this.purgeSession(se.id), wait(se.deleting)).unref());
    for (const t of Object.values(this.s.threads))
      if (t.deleting) this.timers.set(`delt:${t.id}`, setTimeout(() => this.purgeThread(t.id), wait(t.deleting)).unref());
  }

  rearmMirrors() {
    for (const se of Object.values(this.s.sessions)) if (se.backendState?.attached && !se.deleting && !se.archived) this.mirror(se.id);
  }

  stopMirrors() {
    for (const m of this.mirrors.values()) clearInterval(m.timer);
    this.mirrors.clear();
  }

  pollMirror(sessionId) {
    const m = this.mirrors.get(sessionId);
    const se = this.s.sessions[sessionId];
    if (!m) return;
    if (!se || se.deleting) {
      clearInterval(m.timer);
      this.mirrors.delete(sessionId);
      return;
    }
    let entries;
    try {
      entries = m.tail.poll();
    } catch {
      return; // the file is being rewritten; try again next time
    }
    // Lines written during Postbox’s own turn are that turn, already in the thread.
    if (this.turns.has(sessionId) || !entries.length) return;
    for (const e of entries) {
      if (e.isSidechain) continue;
      const typed = typedText(e);
      if (typed) {
        this.addItem(se.threadId, { kind: 'user', text: typed, via: 'terminal' });
        m.agentItem = null;
        m.steps = [];
        this.updateSession(sessionId, { state: 'think', currentStep: 'Working in a terminal', finishedAt: null });
        continue;
      }
      if (e.type === 'assistant') {
        for (const b of e.message?.content ?? []) {
          if (b.type === 'text' && b.text?.trim()) {
            const it = m.agentItem && this.store.item(se.threadId, m.agentItem);
            if (it) this.patchItem(se.threadId, it.id, { text: it.text ? `${it.text}\n\n${b.text}` : b.text });
            else m.agentItem = this.mirrorAgentItem(se, b.text);
            this.updateSession(sessionId, { state: 'gen', currentStep: 'Writing in a terminal' });
          }
          if (b.type === 'tool_use') {
            m.steps.push({ id: b.id, label: describeTool(b.name, b.input), state: 'running', ms: null });
            if (!m.agentItem) m.agentItem = this.mirrorAgentItem(se, '');
            this.patchItem(se.threadId, m.agentItem, { activity: { steps: [...m.steps] } });
            this.updateSession(sessionId, { state: 'tool', currentStep: m.steps.at(-1).label });
          }
        }
        if (e.message?.stop_reason === 'end_turn') this.updateSession(sessionId, { state: 'idle', currentStep: '', finishedAt: Date.now() });
      }
      if (e.type === 'user' && Array.isArray(e.message?.content) && m.agentItem) {
        let changed = false;
        for (const b of e.message.content) {
          const step = b.type === 'tool_result' && m.steps.find((s) => s.id === b.tool_use_id);
          if (step) {
            step.state = b.is_error ? 'failed' : 'done';
            changed = true;
          }
        }
        if (changed) this.patchItem(se.threadId, m.agentItem, { activity: { steps: [...m.steps] } });
      }
    }
  }

  mirrorAgentItem(se, text) {
    return this.addItem(se.threadId, {
      kind: 'agent',
      sessionId: se.id,
      personaId: se.personaId,
      handle: se.handle,
      text,
      status: 'done',
      via: 'terminal',
      activity: null,
    }).id;
  }

  // ── Personas ───────────────────────────────────────────────────────────────────────

  createPersona({
    handle,
    description = '',
    instructions = '',
    backend = 'mock',
    model = backend === 'mock' ? 'mock' : DEFAULT_MODEL,
    permissionMode = 'auto',
    folder = '',
    tools = [],
    examples = [],
    createdBy = null,
  }) {
    handle = String(handle ?? '')
      .replace(/^@/, '')
      .trim();
    if (!/^[a-z][a-z0-9_-]{1,23}$/i.test(handle)) throw httpError(422, 'A name uses 2–24 letters, digits, - or _, and starts with a letter.');
    if (this.personaByHandle(handle)) throw httpError(409, `@${handle} already exists. Pick another name.`);
    if (!this.adapters.names().includes(backend))
      throw httpError(422, `“${backend}” isn’t available on this computer. Available: ${this.adapters.names().join(', ')}. See README, “Run real agents”.`);
    if (!PERMISSION_MODES.includes(permissionMode)) throw httpError(422, `Permissions are one of ${PERMISSION_MODES.join(', ')}.`);
    const p = {
      id: newId('pe'),
      handle,
      description,
      instructions,
      model: String(model || DEFAULT_MODEL),
      backend,
      permissionMode,
      folder: String(folder ?? ''),
      tools: [...new Set(tools)],
      examples,
      createdBy,
      createdAt: Date.now(),
      version: 1,
      retired: false,
    };
    this.store.emit('persona', p);
    return p;
  }

  updatePersona(id, patch) {
    const p = this.persona(id);
    if (!p) throw httpError(404, 'That agent doesn’t exist.');
    if (patch.permissionMode !== undefined && !PERMISSION_MODES.includes(patch.permissionMode))
      throw httpError(422, `Permissions are one of ${PERMISSION_MODES.join(', ')}.`);
    if (patch.backend !== undefined && !this.adapters.names().includes(patch.backend))
      throw httpError(422, `“${patch.backend}” isn’t available on this computer. Available: ${this.adapters.names().join(', ')}.`);
    // A persona moved from the mock to a real model gets the default model.
    if (patch.backend && patch.backend !== 'mock' && (patch.model ?? p.model) === 'mock') patch = { ...patch, model: DEFAULT_MODEL };
    const next = {
      ...p,
      ...pick(patch, ['description', 'instructions', 'backend', 'model', 'permissionMode', 'folder', 'tools', 'examples', 'retired']),
      version: (p.version ?? 1) + 1,
    };
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
    this.timers.set(
      `del:${sessionId}`,
      // Unref’d, like every runtime timer: the HTTP server keeps the process alive, and a test shouldn’t wait.
      setTimeout(() => this.purgeSession(sessionId), DELETE_UNDO_MS).unref(),
    );
    return { until, handle: se.handle };
  }

  /**
   * Deletes a whole conversation or room: every session in it, its apps, and its topic and side threads.
   * Like deleting a session, it waits DELETE_UNDO_MS for Undo first. The personas stay.
   */
  deleteThread(threadId) {
    const t = this.thread(threadId);
    if (t.kind === 'topic' || t.kind === 'side') throw httpError(409, 'Delete the conversation it belongs to instead.');
    const until = Date.now() + DELETE_UNDO_MS;
    for (const se of this.sessionsIn(threadId)) this.stop(se.id, { silent: true });
    this.putThread({ ...t, deleting: until });
    clearTimeout(this.timers.get(`delt:${threadId}`));
    this.timers.set(`delt:${threadId}`, setTimeout(() => this.purgeThread(threadId), DELETE_UNDO_MS).unref());
    return { until, title: t.title };
  }

  undoDeleteThread(threadId) {
    clearTimeout(this.timers.get(`delt:${threadId}`));
    this.timers.delete(`delt:${threadId}`);
    const t = this.thread(threadId);
    this.putThread({ ...t, deleting: null });
  }

  purgeThread(threadId) {
    this.timers.delete(`delt:${threadId}`);
    const t = this.s.threads[threadId];
    if (!t?.deleting) return;
    const ids = [
      threadId,
      ...Object.values(this.s.threads)
        .filter((x) => x.parentId === threadId)
        .map((x) => x.id),
    ];
    for (const id of ids) {
      for (const sid of this.s.threads[id]?.members ?? []) {
        this.stopMirrorFor(sid);
        if (this.s.sessions[sid]) this.store.emit('remove', { kind: 'session', id: sid });
      }
      for (const app of Object.values(this.s.apps)) if (app.threadId === id) this.store.emit('remove', { kind: 'app', id: app.id });
    }
    for (const id of ids.reverse()) this.store.emit('remove', { kind: 'thread', id });
  }

  stopMirrorFor(sessionId) {
    const m = this.mirrors.get(sessionId);
    if (m) clearInterval(m.timer);
    this.mirrors.delete(sessionId);
  }

  renameThread(threadId, title) {
    const t = this.thread(threadId);
    const name = String(title ?? '')
      .trim()
      .slice(0, 120);
    if (!name) throw httpError(422, 'A conversation needs a name.');
    return this.putThread({ ...t, title: name });
  }

  undoDelete(sessionId) {
    clearTimeout(this.timers.get(`del:${sessionId}`));
    this.timers.delete(`del:${sessionId}`);
    const _se = this.session(sessionId);
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
      this.putThread({ ...t, members: others, lastSpeaker: t.lastSpeaker === sessionId ? (others[0] ?? null) : t.lastSpeaker });
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
    this.timers.set(
      sc.id,
      setTimeout(
        () => {
          this.timers.delete(sc.id);
          if (!this.s.schedules[sc.id]) return;
          this.store.emit('schedule', { id: sc.id, removed: true });
          if (sc.itemId) this.patchItem(sc.threadId, sc.itemId, { status: 'done' });
          if (!this.s.sessions[sc.sessionId]) return;
          this.addItem(sc.threadId, { kind: 'system', variant: 'wake', from: sc.handle, to: sc.handle, scheduled: true });
          this.deliver(sc.sessionId, { kind: 'wake', note: sc.note });
        },
        Math.max(0, sc.at - Date.now()),
      ).unref(),
    );
  }

  cancelSchedule(scheduleId) {
    const sc = this.s.schedules[scheduleId];
    if (!sc) throw httpError(404, 'That wake-up already happened or was canceled.');
    clearTimeout(this.timers.get(scheduleId));
    this.store.emit('schedule', { id: scheduleId, removed: true });
    if (sc.itemId) this.patchItem(sc.threadId, sc.itemId, { status: 'canceled' });
  }

  rearmSchedules() {
    for (const sc of Object.values(this.s.schedules)) this.arm(sc);
  }

  // ── Apps ───────────────────────────────────────────────────────────────────────────

  /** The browser reports its pre-display check. The first failure goes back to the agent to fix. */
  appCheck(appId, { version, problems = [] }) {
    const app = this.s.apps[appId];
    if (!app) throw httpError(404, 'That app doesn’t exist.');
    if (version !== app.current) return { ignored: true };
    const clean = (Array.isArray(problems) ? problems : [])
      .slice(0, 20)
      .map((p) => ({ code: String(p?.code).slice(0, 40), message: String(p?.message).slice(0, 300) }));
    if (!clean.length) {
      this.store.emit('app', { ...app, check: { status: 'passed', attempt: app.check.attempt, problems: [] } });
      return { status: 'passed' };
    }
    if (clean.some((p) => p.code === 'script-error')) {
      this.store.emit('app', { ...app, check: { status: 'crashed', attempt: app.check.attempt, problems: clean } });
      return { status: 'crashed' };
    }
    // Problems the agent can’t fix (the frame never answered) are shown as a note, not sent back. Warnings (marks or
    // text too small, an app showing only an error) don’t hold the app back: it’s shown with notes, and the agent
    // hears of them through the lint pipeline, unless it’s already fixing the app.
    const fixable = clean.filter((p) => p.code !== 'no-answer');
    const blocking = fixable.filter((p) => !APP_WARNINGS.has(p.code));
    if (app.check.attempt === 0 && blocking.length && this.s.sessions[app.sessionId]) {
      this.store.emit('app', { ...app, check: { status: 'fixing', attempt: 1, problems: fixable } });
      this.deliver(app.sessionId, { kind: 'app-check', appId, problems: fixable });
      return { status: 'fixing' };
    }
    const notes = clean.every((p) => APP_WARNINGS.has(p.code));
    this.store.emit('app', { ...app, check: { status: 'note', attempt: app.check.attempt, problems: clean, ...(notes ? { notes } : {}) } });
    if (notes) {
      const turnId =
        [...this.turns.values()].find((t) => t.sessionId === app.sessionId)?.id ?? this.store.items(app.threadId).find((i) => i.id === app.itemId)?.turnId;
      const scope = { kind: 'app', id: appId, title: app.title };
      this.lint(
        app.sessionId,
        turnId,
        clean.map((p) => ({ ...p, scope })),
      );
    }
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
    // An app that saves the same state again (on every load, say) changes nothing.
    if (json === JSON.stringify(app.state ?? null)) return;
    this.store.emit('app', { ...app, state: JSON.parse(json) });
  }

  /** An app asks the host for data. It can use only tools both it and its agent were granted. */
  appQuery(appId, tool, args) {
    const app = this.s.apps[appId];
    if (!app) throw httpError(404, 'That app doesn’t exist.');
    const se = this.s.sessions[app.sessionId];
    const persona = se && this.personaFor(se);
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
  isViewing(threadId) {
    return Date.now() - (this.viewing.get(threadId) ?? 0) < 20000;
  }

  // ── UI tools (the same set MCP exposes) ────────────────────────────────────────────

  /** @param {string} sessionId @param {any} [turn]  the turn the tools act for; null outside a turn */
  toolsFor(sessionId, turn = null) {
    const rt = this;
    const se = () => rt.session(sessionId);
    const endSegment = () => {
      if (turn) turn.segment = null;
    };
    const threadId = () => se().threadId;
    return {
      show_block({ block }) {
        const v = validateBlock(block, { imageOrigins: rt.config.imageOrigins });
        // App ids are global. Yours already: it’s a new version. Another agent’s: yours gets a fresh id, and
        // theirs (its versions and saved state) is left alone.
        /** @type {string | null} */
        let renamed = null;
        if (v.ok && v.block.type === 'app' && rt.s.apps[v.block.id]) {
          const { id, code, permissions, title } = /** @type {any} */ (v.block);
          if (rt.s.apps[id].sessionId === sessionId) return this.update_app({ id, code, permissions, title });
          renamed = newId(String(id).slice(0, 40));
          v.block = { ...v.block, id: renamed };
        }
        endSegment();
        const it = rt.addItem(
          threadId(),
          v.ok
            ? { kind: 'block', sessionId, handle: se().handle, turnId: turn?.id ?? null, valid: true, block: v.block, answered: false }
            : {
                kind: 'block',
                sessionId,
                handle: se().handle,
                turnId: turn?.id ?? null,
                valid: false,
                raw: block,
                errors: v.errors,
                reason: v.reason,
                fallback: v.fallback,
              },
        );
        if (v.ok && v.block.type === 'app') rt.registerApp(sessionId, v.block, it.id);
        return v.ok
          ? { ok: true, message: renamed ? `That app id was taken, so it’s shown as ${renamed}. Use that id to update it.` : `Shown block ${v.block.id}.` }
          : { ok: false, message: `The block was invalid, so the person sees its fallback text. Problems: ${v.errors.join(' ')}` };
      },
      update_block({ block }) {
        const v = validateBlock(block, { imageOrigins: rt.config.imageOrigins });
        if (!v.ok) return { ok: false, message: `The update was invalid and wasn’t applied: ${v.errors.join(' ')}` };
        const existing = [...rt.store.items(threadId())]
          .reverse()
          .find((x) => x.kind === 'block' && x.valid && x.block.id === v.block.id && x.sessionId === sessionId);
        if (!existing) return { ok: false, message: `There’s no block with id ${v.block.id} to update. Use show_block to add it.` };
        if (existing.block.type !== v.block.type) return { ok: false, message: 'An update can’t change a block’s type.' };
        // An update can ask again, so it reopens a block you already answered.
        const now = Date.now();
        /** @type {Record<string, any>} */
        const patch = { block: v.block, answered: false, answer: null, revision: (existing.revision ?? 1) + 1, updatedAt: now };
        if (v.block.type === 'progress') Object.assign(patch, stampSteps(existing, v.block, now));
        // Asking again belongs to this turn, so its end shows the person this agent needs them (#69).
        if (ASKING.has(v.block.type) && turn) patch.turnId = turn.id;
        rt.patchItem(threadId(), existing.id, patch);
        return { ok: true, message: `Updated block ${v.block.id}.` };
      },
      show_app({ id, title, code, permissions = [], fallback }) {
        const blockId = id ?? newId('app');
        const existing = rt.s.apps[blockId];
        if (existing?.sessionId === sessionId) return this.update_app({ id: blockId, code, permissions, title });
        return this.show_block({
          block: {
            id: blockId,
            type: 'app',
            version: 1,
            title: title ?? 'App',
            fallback: fallback ?? `${title ?? 'An app'}: open Postbox to use it.`,
            code,
            permissions,
          },
        });
      },
      update_app({ id, code, permissions, title, summary = '' }) {
        const app = rt.s.apps[id];
        if (!app || app.sessionId !== sessionId) return { ok: false, message: `There’s no app with id ${id} from you.` };
        const v = validateBlock({ id, type: 'app', version: 1, fallback: 'x', code, permissions: permissions ?? app.versions[app.current - 1].permissions });
        if (!v.ok) return { ok: false, message: `The update was invalid: ${v.errors.join(' ')}` };
        const versions = [
          ...app.versions,
          { v: app.versions.length + 1, code, permissions: v.block.permissions ?? [], summary: String(summary ?? '').slice(0, 300), at: Date.now() },
        ];
        rt.store.emit('app', {
          ...app,
          title: typeof title === 'string' && title.trim() ? title.slice(0, 200) : app.title,
          versions,
          current: versions.length,
          check: { status: 'pending', attempt: app.check.attempt },
        });
        return { ok: true, message: `App ${id} is now v${versions.length}.` };
      },
      define_term({ term, definition, key, source }) {
        if (!term || !definition) return { ok: false, message: 'define_term needs a term and a definition.' };
        const k =
          String(key ?? term)
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '')
            .slice(0, 64) || 'term';
        if (turn) (turn.defined ??= []).push(String(term).slice(0, 80));
        rt.store.emit('glossary', {
          threadId: threadId(),
          entry: {
            key: k,
            term: String(term).slice(0, 80),
            definition: String(definition).slice(0, 2000),
            source: source ? String(source).slice(0, 200) : '',
            by: se().handle,
            at: Date.now(),
          },
        });
        const inherited = rt
          .lineage(threadId())
          .slice(1)
          .some((id) => rt.s.glossary[id]?.[k]);
        return { ok: true, message: inherited ? `Defined “${term}” in this thread, over the conversation’s definition.` : `Defined “${term}”.` };
      },
      propose_agent({ handle, description, instructions, tools = [], model = 'mock', backend = 'mock' }) {
        const mine = new Set(rt.persona(se().personaId)?.tools ?? []);
        // Agents send JSON: anything that isn’t a string here is coerced, so it can only ever show as text.
        const str = (v, max) => String(v ?? '').slice(0, max);
        handle = str(handle, 40);
        description = str(description, 500);
        instructions = str(instructions, 20000);
        tools = (Array.isArray(tools) ? tools : []).filter((t) => typeof t === 'string').slice(0, 40);
        model = str(model, 80);
        backend = str(backend, 40);
        endSegment();
        rt.addItem(threadId(), {
          kind: 'proposal',
          sessionId,
          handle: se().handle,
          status: 'open',
          proposal: { handle: String(handle).replace(/^@/, ''), description, instructions, tools, model, backend },
          extraTools: tools.filter((t) => !mine.has(t)),
        });
        return { ok: true, message: 'Proposed. The person decides whether to create it.' };
      },
      schedule_wake({ in_minutes, note }) {
        const sc = rt.schedule(sessionId, { inMs: Math.round((+in_minutes || 1) * 60000), note });
        return { ok: true, message: `You’ll be woken at ${new Date(sc.at).toISOString()}.` };
      },
      wake_agent({ handle, message }) {
        return rt.agentWake(sessionId, String(handle).replace(/^@/, ''), String(message ?? ''));
      },
      read_conversation(args = {}) {
        return { ok: true, message: rt.readConversation(se(), args) };
      },
      corpus_search(args) {
        return { ok: true, results: hostTool(rt, 'corpus.search', args) };
      },
    };
  }

  registerApp(sessionId, block, itemId) {
    const se = this.s.sessions[sessionId];
    this.store.emit('app', {
      id: block.id,
      threadId: se.threadId,
      sessionId,
      itemId,
      title: block.title ?? 'App',
      versions: [{ v: 1, code: block.code, permissions: block.permissions ?? [], at: Date.now(), summary: '' }],
      current: 1,
      state: null,
      check: { status: 'pending', attempt: 0, problems: [] },
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
    case 'corpus.read':
      return rt.corpus.read(String(args.id ?? ''));
    case 'corpus.stats':
      return rt.corpus.stats();
    case 'narrate.speak':
      if (!rt.narrator) throw httpError(503, 'Narration isn’t installed here. Run npm install to add Kokoro, then restart Postbox.');
      return rt.narrator.speak(args);
    default:
      throw httpError(404, `There’s no host tool called “${tool}”.`);
  }
}

/**
 * A progress update’s step times, kept beside the block: startedAt when a step starts running, endedAt when it
 * stops. A step that finishes without a duration gets one from them.
 * @param {any} item  the block as it was  @param {any} block  the update  @param {number} now
 */
function stampSteps(item, block, now) {
  const was = new Map((item.block.steps ?? []).map((s) => [s.id, s.state]));
  /** @type {Record<string, { startedAt?: number, endedAt?: number }>} */
  const times = {};
  const steps = block.steps.map((s) => {
    const before = was.get(s.id);
    const t = { ...(item.stepTimes?.[s.id] ?? {}) };
    const going = before === 'running' || before === 'stalled';
    // A step that was running when the block was shown started then.
    if (going) t.startedAt ??= item.at;
    if (s.state === 'running') {
      if (!going) t.startedAt = now;
      delete t.endedAt;
    } else if (going && s.state !== 'pending') t.endedAt = now;
    times[s.id] = t;
    const finished = s.state === 'done' || s.state === 'failed';
    return finished && !s.duration && t.startedAt && t.endedAt ? { ...s, duration: formatDuration(t.endedAt - t.startedAt) } : s;
  });
  return { block: { ...block, steps }, stepTimes: times };
}

export function httpError(status, message) {
  return Object.assign(new Error(message), { status, userMessage: message });
}
const snapshotOf = (p) => pick(p, ['description', 'instructions', 'model', 'permissionMode', 'folder', 'tools', 'version']);
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));

export { formatDuration };
