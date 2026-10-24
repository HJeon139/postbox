// The runtime: threads, sessions and turns. It decides who replies, wakes agents, enforces the wake
// limit, queues messages sent mid-reply, handles Stop, tracks what "needs you", and implements the UI
// tools that agents call (over MCP, or in-process for the mock).

import { createHash, randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ASKING, validateBlock } from '../shared/catalog.mjs';
import { COLUMN_PX, lintDiagrams, MIN_TEXT_PX, mermaidBlocks } from '../shared/diagram-lint.mjs';
import { LIMITS, limitText, READING } from '../shared/limits.mjs';
import { commentAt } from '../shared/review-comments.mjs';
import { formatDuration, parseMentions } from '../shared/text.mjs';
import { carriedList, turnLine } from '../shared/work.mjs';
import { describeTool } from './adapters/claude-stream.mjs';
import { listProcesses, runsCommand, stopPgid } from './adapters/process-group.mjs';
import { DEFAULT_EFFORT, EFFORT_LEVELS, POSTBOX_SERVER, PUBLISHING_TOOLS, setupOf, TOOL_RULES, writeRules } from './adapters/setup.mjs';
import { listClaudeSessions, recentHistory, TranscriptTail, typedText } from './adapters/terminal-mirror.mjs';
import { agentFile, agentFolders, appFiles } from './agent-files.mjs';
import { retireApp } from './app-retire.mjs';
import {
  APP_HOLD_MAX,
  APP_SEND_LIMIT,
  APP_SEND_WINDOW_MS,
  appCheck,
  appEvent,
  appFile,
  appQuery,
  appState,
  hostTool,
  needAppSend,
  registerApp,
  resolveAppSend,
  updateApp,
} from './apps.mjs';
import { act, answerDelivered, CATCH_UP_CHARS, closedText, OUTCOME_LATER, unreadAnswer, updateBlock } from './blocks.mjs';
import { blockProblems, diagramProblems, formatLint, introducedTerms, lintMessage, personSaid, rawHtmlProblems, termProblems } from './checks.mjs';
import { parseDataset } from './corpus.mjs';
import { clip, clipText, fenced, httpError } from './helpers.mjs';
import { Ledger } from './ledger.mjs';
import {
  allowAlways,
  alwaysFor,
  askPerson,
  expireStalePermissions,
  readsRules,
  recordDenial,
  requestPermission,
  resolveDenial,
  resolvePermission,
  settlePermission,
} from './permission-cards.mjs';
import { BEHAVIORS, changeRule, cleanRule, readRules, settingsFiles } from './permission-rules.mjs';
import { readCapped } from './read-capped.mjs';
import { reviewBlock } from './review-comments.mjs';
import { runShell } from './shell.mjs';
import {
  agentWake,
  archiveForks,
  bringToConversation,
  bumpSideLink,
  deliverWake,
  dropWakes,
  recordAgentMessage,
  resolveHop,
  sideSession,
  threadPersona,
  wakeAgent,
} from './side-threads.mjs';
import { newId } from './store.mjs';
import { endSubagent, notUrgent } from './subagent-end.mjs';
import { reactionLines, settleThread, threadCatchUp, threadLines } from './thread-summary.mjs';
import { askForTool, settleToolAsks } from './tool-ask.mjs';

export { AgentFileError } from './agent-files.mjs';
export { hostTool } from './apps.mjs';
export { httpError } from './helpers.mjs';
export { HOP_LIMIT } from './side-threads.mjs';
export { readCapped };

/** @typedef {import('./agent-files.mjs').AppFile} AppFile */

const DELETE_UNDO_MS = 10000;
/** The days a conversation can sit with nothing happening before it archives itself (#101), unless Settings says otherwise. */
export const ARCHIVE_AFTER_DAYS = 7;
export const ARCHIVE_AFTER_CHOICES = [0, 1, 3, 7, 30]; // 0: never
/** How long a lint turn waits after its agent turn ends for what the browser measures (diagrams, the app check). */
const LINT_SETTLE_MS = 1500;
/** …and at most, while an app of the agent’s is still being checked. */
const LINT_WAIT_MAX_MS = 12000;
/**
 * What a persona may do without asking. auto (the default): Claude Code’s safety classifier approves routine
 * actions and asks you only when it can’t decide. ask: ask before anything risky. acceptEdits: edit files
 * freely, ask before commands. bypass: never ask.
 */
export const PERMISSION_MODES = ['auto', 'ask', 'acceptEdits', 'bypass'];
const STEP_STATES = new Set(['running', 'done', 'failed', 'denied', 'stopped']);
/** What a step is when it isn’t a tool call (#73): a thought, a subagent’s narration, or a subagent’s own step. */
const STEP_KINDS = /** @type {Set<unknown>} */ (new Set(['thought', 'said', 'agent']));
/** How often Postbox checks whether a background job it kept running has ended (#129). */
const KEPT_POLL_MS = 5000;
/** The background jobs Postbox keeps on a session, at most. */
const MAX_JOBS = 50;
/** How long a stopped turn may hold its session before Postbox lets the next turn start anyway, and says so (#126). */
const STOP_WATCHDOG_MS = 15000;
/** The model a real backend uses when a persona doesn’t name one. */
export const DEFAULT_MODEL = 'claude-opus-5-5';
const CATCH_UP_ITEMS = 40;
const count = (n) => n.toLocaleString('en-US');
/**
 * What a turn was asked, kept on its failed reply so Retry sends it again as it was, with its own kind (#151): a wake
 * answers the agent that asked again, and an agent’s or Postbox’s turn never comes back as the person’s.
 */
const askedOf = ({ asked: { message, replyTo, summarizeTo } }) => ({ message, replyTo: replyTo ?? null, summarizeTo: summarizeTo ?? null });
/**
 * An item’s text cut to n characters for an agent’s history. A cut says how much was kept and gives the id
 * read_message takes, so the agent can read the rest (#109).
 */
const clipItem = (s, n, id) => {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n)}… (${count(n)} of ${count(t.length)} characters; read_message { id: "${id}" } has the rest)` : t;
};

/**
 * What a block holds, as text an agent can read and quote (#153): a review, card or code block’s content, a choice
 * or form’s prompt and options or fields, any other block’s fallback, and the person’s answer if there is one. An
 * app is its title alone, which its agent’s line names.
 * @param {any} it  a block item
 */
function blockContent(it) {
  const b = it.block ?? {};
  const out = [];
  const lines = (list) => list.map((x) => `- ${x}`).join('\n');
  switch (b.type) {
    case 'review':
      if (b.format === 'app') out.push(`It reviews the app ${b.appId}.`);
      else out.push(b.format === 'code' ? `${b.filename ? `${b.filename}:\n` : ''}${fenced(b.content ?? '', b.language)}` : String(b.content ?? ''));
      for (const th of b.threads ?? []) out.push(`Comments on ${commentAt(th)} (${th.status}):\n${lines(th.comments.map((c) => `${c.author}: ${c.text}`))}`);
      break;
    case 'card':
      if (b.body) out.push(b.body);
      if (b.facts?.length) out.push(lines(b.facts.map((f) => `${f.label}: ${f.value}`)));
      if (b.actions?.length) out.push(`Buttons: ${b.actions.map((x) => x.label).join(' · ')}`);
      break;
    case 'code':
      out.push(`${b.filename ? `${b.filename}:\n` : ''}${fenced(b.code ?? '', b.language)}`);
      break;
    case 'choice':
      if (b.prompt) out.push(b.prompt);
      out.push(
        `Options${b.multiple ? ' (any of them)' : ''}: ${b.options.map((o) => o.label).join(' · ')}${b.other ? `, or their own (${b.other.label})` : ''}`,
      );
      break;
    case 'form':
      if (b.prompt) out.push(b.prompt);
      out.push(
        `Fields:\n${lines(b.fields.map((f) => `${f.label} (${f.kind}${f.required ? ', required' : ''})${f.options ? `: ${f.options.map((o) => o.label).join(' · ')}` : ''}`))}`,
      );
      break;
    case 'confirm':
      out.push(b.statement);
      break;
    case 'app':
      return '';
    default:
      out.push(String(b.fallback ?? ''));
  }
  const a = it.answered ? it.answer : null;
  if (it.closed) out.push(closedText(it));
  else if (a) {
    const v = a.values ?? {};
    if (b.type === 'review') {
      const comments = Array.isArray(v.comments) ? v.comments : [];
      out.push(
        `The person’s review: ${String(a.voice ?? '').replace(/^Submitted review: /, '')}${comments.length ? `\n${lines(comments.map((c) => `${commentAt(c)}: ${c.text}`))}` : ''}`,
      );
    } else if (b.type === 'form') {
      const shown = (f) => {
        const x = v[f.id];
        if (f.kind === 'toggle') return x ? 'on' : 'off';
        if (f.kind === 'select') return f.options?.find((o) => o.id === x)?.label ?? x;
        return String(x);
      };
      out.push(
        `The person answered:\n${lines(b.fields.filter((f) => v[f.id] !== undefined && v[f.id] !== '').map((f) => `${f.label}: ${shown(f)}`)) || '- (nothing filled in)'}`,
      );
    } else if (b.type === 'choice') {
      const picked = (v.selected ?? []).map((id) => b.options.find((o) => o.id === id)?.label ?? id);
      out.push(`The person answered: ${[...picked, ...(v.other ? [`“${v.other}”`] : [])].join(' · ')}`);
    } else out.push(`The person answered: ${a.voice ?? a.action}`);
  }
  if (b.outcome) out.push(`Outcome: ${b.outcome}`);
  return out.filter(Boolean).join('\n\n');
}

export class Runtime {
  /**
   * @param {{ store: import('./store.mjs').Store, adapters: import('./adapters/adapter.mjs').AdapterRegistry,
   *           corpus: import('./corpus.mjs').Corpus, config: { origin: string, imageOrigins: string[], claudeProjectsRoot?: string, versions?: any, lintSettleMs?: number, home?: string },
   *           blobs?: import('./blobs.mjs').Blobs, narrator?: import('./narration/narrator.mjs').Narrator|null,
   *           spawnShell?: typeof import('node:child_process').spawn, signalProcess?: import('./adapters/process-group.mjs').KillFn,
   *           listProcesses?: () => Promise<import('./adapters/process-group.mjs').Proc[]>, ledger?: Ledger }} deps
   *   spawnShell: how `!command` starts a process (#67); signalProcess and listProcesses: how a background job Postbox
   *   kept running is signaled, and found to check it’s still the same process (#129). Tests pass fakes.
   *   ledger: the work ledger (#132); tests pass one with fake files and git
   */
  constructor({ store, adapters, corpus, config, blobs, narrator, spawnShell, signalProcess, listProcesses: list, ledger }) {
    this.store = store;
    this.adapters = adapters;
    this.corpus = corpus;
    this.config = config;
    // Where the person’s Claude Code user settings are read and written (#66); tests and checks pass a temp folder.
    this.home = config.home ?? homedir();
    // CLAUDE_CONFIG_DIR moves the user settings (permission-rules.mjs, settingsFiles); an injected home never reads it.
    const { claudeConfigDir } = /** @type {{ claudeConfigDir?: string|null }} */ (config);
    this.configDir = claudeConfigDir !== undefined ? claudeConfigDir : this.home === homedir() ? process.env.CLAUDE_CONFIG_DIR || null : null;
    this.blobs = blobs ?? null;
    this.narrator = narrator ?? null;
    this.permissionWaits = new Map(); // permission item id → { resolve, threadId, sessionId }
    this.mirrors = new Map(); // attached session id → { tail, timer, agentItem, steps }
    this.turns = new Map(); // sessionId → live turn
    // sessionId → a stopped turn whose process hasn’t exited yet, and what waits for it: { turn, held, silent } (#126)
    this.exiting = new Map();
    this.signalProcess = signalProcess ?? process.kill;
    this.listProcesses = list ?? listProcesses;
    this.closing = false; // Postbox is shutting down: no new turn starts (#126)
    /** @type {NodeJS.Timeout|null} */
    this.keptPoll = null; // checks on the background jobs Postbox kept running (#129)
    this.viewing = new Map(); // threadId → last time a browser said it was open
    this.timers = new Map(); // scheduleId or deletion → timeout
    this.lints = new Map(); // agent turn id → its lint turn, gathering: { sessionId, kind, ended, sent, problems, timer }
    this.lastTurn = new Map(); // sessionId → the id of its last turn that ended
    this.spawnShell = spawnShell ?? undefined;
    this.shellRuns = new Map(); // command item id → { stop, kill, done, flush, stopped, closing }
    // What each conversation’s agents changed, ran and published (#132).
    this.ledger = ledger ?? new Ledger({ store, blobs: this.blobs, home: this.home });
    // Forks are gone (#228): any left from before are archived, once.
    archiveForks(this);
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
    return (
      p && {
        ...p,
        ...(se.personaSnapshot ?? {}),
        backend: p.backend,
        permissionMode: p.permissionMode ?? 'auto',
        // Whether it loads your Claude Code setup and may publish outside Postbox are permissions too (#57), and
        // so are the MCP servers it turned off (#59) and its tools, which real backends deny when unticked (#5).
        usesHostSetup: p.usesHostSetup !== false,
        canPublish: p.canPublish === true,
        mcpOff: p.mcpOff ?? [],
        tools: p.tools ?? [],
      }
    );
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
  /**
   * The other agents in a turn’s conversation, with their roles, for the guide: the room tells each agent who else is
   * here and what they do, so a persona’s own prompt needn’t know its team. A side or topic thread’s room is its
   * conversation’s.
   * @param {string} threadId @param {any} se  the agent the guide is for
   * @returns {{ handle: string, role: string }[]}
   */
  roomOf(threadId, se) {
    const t = this.s.threads[threadId];
    const conv = t?.parentId && this.s.threads[t.parentId] ? t.parentId : threadId;
    const seen = new Set([se.handle]);
    return this.sessionsIn(conv)
      .filter((x) => !x.archived && !seen.has(x.handle) && seen.add(x.handle))
      .map((x) => ({ handle: x.handle, role: clipText(String(this.persona(x.personaId)?.description ?? ''), 200) }));
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
    // …and a message in a side thread on its line in the conversation, whoever wrote it (#130).
    if (t?.kind === 'side' && (it.kind === 'user' || it.kind === 'agent')) this.bumpSideLink(threadId);
    return it;
  }
  patchItem(threadId, id, patch) {
    this.store.emit('item.patch', { threadId, id, patch });
  }
  /**
   * Brings an item to the newest point in its thread (#49, #92), for an update the person has to see: an app’s new
   * version, or a block that asks again. The agent explains the change in its newest message, so the item belongs
   * beside it. The item keeps its id, so there’s only ever one live copy, and a one-line stub takes its old place and
   * leads to it. An item that’s already the newest just takes the patch.
   * @param {string} threadId @param {string} id
   * @param {{ what: 'app'|'block', title: string, v?: number }} stub  what the stub says moved
   * @param {Record<string, any>} [patch]  set on the item as it moves
   * @returns {boolean} whether it moved
   */
  bringForward(threadId, id, stub, patch = {}) {
    const items = this.store.items(threadId);
    const i = items.findIndex((x) => x.id === id);
    if (i < 0) return false;
    if (i === items.length - 1) {
      if (Object.keys(patch).length) this.patchItem(threadId, id, patch);
      return false;
    }
    const now = Date.now();
    const st = { id: newId('it'), kind: 'moved', at: now, itemId: id, ...stub, ...carriedList(items[i]).stub };
    this.store.emit('item.move', { threadId, id, stub: st, patch: { ...patch, ...carriedList(items[i]).item, at: now, movedAt: now } });
    // A session whose catch-up marker was the item now reads on from the stub, where the item was, so what came
    // after it isn’t skipped.
    for (const se of this.sessionsIn(threadId)) if (se.seenItem === id) this.updateSession(se.id, { seenItem: st.id });
    return true;
  }
  updateSession(id, patch) {
    const se = this.s.sessions[id];
    if (!se) return;
    this.putSession({ ...se, ...patch, updatedAt: Date.now() });
  }
  /** threadId: where it happened, when that isn’t the session’s own thread (a turn in a side thread, #110). */
  notify(level, se, title, text, threadId = null) {
    this.store.emit('notify', { level, sessionId: se.id, threadId: threadId ?? se.threadId, handle: se.handle, title, text });
  }

  // ── Projects, threads, sessions ────────────────────────────────────────────────────

  /** @param {{ projectId: string, title: string, personaIds?: string[], kind?: string, parentId?: string|null }} opts */
  createThread({ projectId, title, personaIds = [], kind = 'thread', parentId = null }) {
    if (!this.s.projects[projectId]) throw httpError(404, 'That project doesn’t exist.');
    const t = this.putThread({
      id: newId('th'),
      projectId,
      title: title || 'New conversation',
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
  /**
   * @param {string} threadId @param {string} personaId
   * @param {{ brief?: string|null, joined?: { by: string, in: string } | null }} [opts]
   *   joined: it joins to answer in a side thread, woken by `by` (a handle, or 'you') in thread `in` (#110)
   */
  ensureSession(threadId, personaId, { brief, joined = null } = {}) {
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
      // The person never added it, so its row says why it’s here (decided by the person, 23 October 2026).
      ...(joined ? { joinedBy: joined.by, joinedIn: joined.in } : {}),
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
    // A side or topic thread is answered by the conversation’s own sessions (#110, #128, #228): an agent you
    // @-mention there, or the one you reply to, answers from its one session in the conversation, and the reply shows here.
    const away = t.kind === 'side' || t.kind === 'topic';
    if (away) {
      for (const p of mentioned) targets.push({ se: this.sideSession(t, p.id, 'you'), woke: true });
      if (!targets.length) {
        // The last speaker’s agent replies, as in a conversation; before anyone has, the agent it started with.
        const p = threadPersona(this, t);
        const se = p && this.sideSession(t, p.id, 'you');
        if (!se) throw httpError(409, `No agent is in this ${t.kind === 'side' ? 'side thread' : 'thread'}. @-mention one to bring it in.`);
        targets.push({ se, woke: false });
      }
    }
    // Refuse before anything is posted, so a refused message doesn’t also appear in the transcript.
    const archived = mentioned.map((p) => this.sessionsIn(threadId).find((x) => x.personaId === p.id)).find((x) => x?.archived);
    if (archived && !away) throw httpError(409, `@${archived.handle}’s session is archived. Restore it first.`);
    for (const p of away ? [] : mentioned) {
      const joined = !this.sessionsIn(threadId).some((x) => x.personaId === p.id);
      targets.push({ se: this.ensureSession(threadId, p.id, { brief: joined ? 'You were @-mentioned into this thread.' : null }), woke: true });
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
    // Send now is a change of course: background jobs keep running, each with its own Stop (#129).
    for (const { se } of busy) this.stop(se.id, { silent: true, jobs: 'keep' });
    return this.postAndDeliver(threadId, { text, attachments }, targets);
  }

  postAndDeliver(threadId, { text, attachments }, targets) {
    const item = this.addItem(threadId, { kind: 'user', text, attachments });
    // You’re here: the wake limit starts again, on the conversation, where agents’ wakes count (#108, #228).
    const conv = this.lineage(threadId).at(-1);
    this.putThread({ ...this.s.threads[conv], hops: 0 });
    const refs = this.threadRefs(threadId, text);
    for (const { se, woke } of targets) {
      if (woke) this.addItem(threadId, { kind: 'system', variant: 'wake', from: 'you', to: se.handle });
      this.deliver(se.id, { kind: 'user', text, attachments, itemId: item.id, ...(refs.length ? { context: refs } : {}) }, { threadId });
    }
    return { item };
  }

  /**
   * The threads a message of yours links to (#121), as Copy link or the composer’s # gives them, each with its id and
   * title so the agent can read it. Only threads of the same conversation: read_conversation reads no others.
   * @param {string} threadId @param {string} text
   */
  threadRefs(threadId, text) {
    const root = (x) => this.lineage(x).at(-1);
    const ids = new Set();
    for (const m of String(text).matchAll(/#\/t\/(th_[A-Za-z0-9]+)(?:\/side\/(th_[A-Za-z0-9]+))?/g)) ids.add(m[2] ?? m[1]);
    const out = [];
    for (const id of [...ids].slice(0, 10)) {
      const t = this.s.threads[id];
      if (!t || t.deleting || id === threadId || root(id) !== root(threadId)) continue;
      const what = t.kind === 'side' ? 'side thread' : t.kind === 'topic' ? 'topic thread' : 'conversation';
      out.push(`[Postbox] The person’s message links to the ${what} “${t.title}” (thread ${id}). Read it with read_conversation with thread: "${id}".`);
    }
    return out;
  }

  editQueued(threadId, queueId, text) {
    const t = this.thread(threadId);
    if ((t.queue ?? []).find((q) => q.id === queueId)?.kind === 'wake') throw httpError(409, 'An agent’s message can’t be edited. Remove it instead.');
    const queue = (t.queue ?? []).map((q) => (q.id === queueId ? { ...q, text: String(text) } : q));
    this.putThread({ ...t, queue });
  }

  cancelQueued(threadId, queueId) {
    const t = this.thread(threadId);
    const q = (t.queue ?? []).find((x) => x.id === queueId);
    this.putThread({ ...t, queue: (t.queue ?? []).filter((x) => x.id !== queueId) });
    // A wake you removed: its agent was told it would be answered, so it hears it won’t be (#228).
    if (q?.kind === 'wake' && this.s.sessions[q.fromSessionId] && !this.s.sessions[q.fromSessionId].archived)
      this.tellAgent(q.fromSessionId, `The person removed your message (“${clip(q.text, 120)}”) before it was answered. Carry on without it.`);
  }

  /** Send now: stops the agent’s current turn and delivers the queued message at once. */
  sendQueuedNow(threadId, queueId) {
    const t = this.thread(threadId);
    const q = (t.queue ?? []).find((x) => x.id === queueId);
    if (!q) throw httpError(404, 'That queued message was already sent or removed.');
    this.putThread({ ...t, queue: t.queue.filter((x) => x.id !== queueId) });
    for (const id of q.sessionIds) this.stop(id, { silent: true, jobs: 'keep' });
    if (q.kind === 'wake') return deliverWake(this, threadId, q);
    return this.postAndDeliver(
      threadId,
      q,
      q.sessionIds.map((id) => ({ se: this.s.sessions[id], woke: false })).filter((x) => x.se && !x.se.archived),
    );
  }

  /** Once Postbox listens after a restart: what waited in the queues goes now, a wake or a message of yours (#228). */
  drainAll() {
    for (const t of Object.values(this.s.threads)) if (t.queue?.length && !t.deleting) this.drainQueue(t.id);
  }

  /**
   * Sends what can go from a thread’s queue: every item whose agents are free, in order for each agent, so one waiting
   * for a busy agent holds back nothing for another (#228). wakesOnly: only agents’ wakes, after a failed turn, when
   * your own messages wait for you to see the failure.
   */
  drainQueue(threadId, wakesOnly = false) {
    const t = this.s.threads[threadId];
    if (!t?.queue?.length) return;
    const held = new Set();
    const go = [];
    for (const q of t.queue) {
      const free = !q.sessionIds.some((id) => held.has(id) || this.turns.has(id) || this.exiting.has(id));
      if (free && (!wakesOnly || q.kind === 'wake')) go.push(q);
      if (!wakesOnly || q.kind === 'wake') for (const id of q.sessionIds) held.add(id);
    }
    if (!go.length) return;
    this.putThread({ ...t, queue: t.queue.filter((x) => !go.includes(x)) });
    for (const q of go) this.sendQueued(threadId, q);
  }

  /** One item from a queue: a wake to its agent, or your message, posted and delivered. */
  sendQueued(threadId, q) {
    if (q.kind === 'wake') return deliverWake(this, threadId, q);
    this.postAndDeliver(
      threadId,
      q,
      q.sessionIds.map((id) => ({ se: this.s.sessions[id], woke: false })).filter((x) => x.se && !x.se.archived),
    );
  }

  // ── Turns ──────────────────────────────────────────────────────────────────────────

  /**
   * Runs one agent turn through its adapter.
   * threadId: where the turn speaks, when that isn’t the session’s own thread: a conversation session answers in a side
   * thread (#110), so one persona has one memory per conversation.
   * @param {string} sessionId @param {any} message
   * @param {{ replyTo?: string|null, summarizeTo?: string|null, threadId?: string|null }} [opts]
   */
  deliver(sessionId, message, { replyTo = null, summarizeTo = null, threadId = null } = {}) {
    const se = this.session(sessionId);
    // As it was asked, for Retry (askedOf).
    const asked = { message, replyTo, summarizeTo, threadId };
    if (se.archived) throw httpError(409, `@${se.handle}’s session is archived. Restore it first.`);
    if (this.turns.has(sessionId)) {
      // Agent-to-agent messages and events wait for the current turn to end.
      const t = this.turns.get(sessionId);
      t.pending.push({ message, replyTo, summarizeTo, threadId });
      return;
    }
    // A stopped turn’s process is still exiting: the next turn waits for it, so a session never runs two (#126). An answer
    // held here isn’t read yet: it’s read when the turn it starts begins.
    const exiting = this.exiting.get(sessionId);
    if (exiting) {
      exiting.held.push({ message, replyTo, summarizeTo, threadId });
      return;
    }
    // Shutting down: a new CLI would outlive Postbox. A message you sent waits in the queue (turnExited).
    if (this.closing) return;
    const where = threadId && threadId !== se.threadId && this.s.threads[threadId] ? threadId : se.threadId;
    this.answerDelivered(where, message);
    // A skill or command (#67) is the whole prompt, since Claude Code runs it only when the prompt starts with /name:
    // the context below waits for the agent’s next turn instead.
    const slash = message.slash === true;
    // Context that waited for this agent’s next turn (shared from a topic thread, or a topic’s brief) goes first.
    if (se.context?.length && !slash) {
      // Not an urgent note to stop a subagent (#229): its turn ended, and the subagent with it.
      message = { ...message, context: [...notUrgent(se.context), ...(message.context ?? [])] };
      this.updateSession(sessionId, { context: [] });
    }
    // Problems the checks found in its last reply, still waiting to go as a lint turn, come with this turn instead.
    if (message.kind !== 'lint' && !slash) message = this.foldLint(sessionId, message);
    // And before that, what happened in the conversation since this agent last took part: a room is shared
    // memory, so an agent that wasn’t woken for something can still catch up on it (issue #1).
    // …and in the topic or side thread it answers in, what was said there since it last took part (#228).
    const there = slash || where === se.threadId ? null : threadCatchUp(this, this.s.sessions[sessionId], where, message.itemId);
    const catchUp = [slash ? null : this.catchUp(this.s.sessions[sessionId], message.itemId), there].filter(Boolean);
    if (catchUp.length) message = { ...message, context: [...catchUp, ...(message.context ?? [])] };
    const persona = this.persona(se.personaId);
    const adapter = this.adapters.get(persona?.backend ?? 'mock');
    const abort = new AbortController();
    const turn = {
      id: newId('turn'),
      kind: message.kind,
      // Whether this is the person moving on (#69): their message or an event of theirs, not another agent’s review (#133).
      movesOn: message.kind === 'user' || (message.kind === 'event' && !message.event?.from),
      from:
        message.kind === 'agent'
          ? String(message.from ?? '')
              .replace(/^@/, '')
              .toLowerCase()
          : null,
      sessionId,
      threadId: where,
      segment: null,
      first: null,
      steps: [],
      abort,
      closed: false,
      replyTo,
      // Where the agent that woke this one speaks: the reply goes back to it there (#228).
      replyIn: message.replyIn ?? null,
      summarizeTo,
      checkpoint: null,
      pending: [],
      said: '',
      startedAt: Date.now(),
      // This turn’s own MCP token: a call that carries another turn’s, such as a stopped one’s, is refused (#126).
      token: randomUUID(),
      /** @type {Promise<void>} resolves once the adapter is done, which for a real backend is when its process has exited */
      exited: Promise.resolve(),
      /** @type {Set<string>} background jobs Stop was asked to keep running (#129) */
      keepJobs: new Set(),
      asked,
    };
    this.turns.set(sessionId, turn);
    // The work ledger (#132) follows the turn’s tool calls. A change outside the project’s folder and the agent’s is
    // flagged; the adapter knows the agent’s folder.
    const project = this.s.projects[this.s.threads[se.threadId]?.projectId] ?? null;
    this.ledger.startTurn(turn, {
      se,
      folder: adapter?.folderFor ? Promise.resolve().then(() => adapter.folderFor(persona, project)) : persona?.folder || project?.folder || null,
      projectFolder: project?.folder ?? null,
    });
    // Rules the person allowed once (from a refusal card) apply to this turn only.
    turn.allowOnce = se.allowOnce ?? [];
    this.updateSession(sessionId, {
      allowOnce: [],
      endingSubagents: [],
      glimpse: '',
      // Where the turn is, when it’s in a side thread (#121): the conversation shows the agent at work there.
      sideTurn: where === se.threadId ? null : { threadId: where, by: message.kind === 'agent' ? turn.from : message.kind === 'user' ? 'you' : null },
      state: 'think',
      needs: turn.movesOn ? null : se.needs,
      currentStep: 'Thinking',
      finishedAt: null,
    });
    const ctx = this.turnContext(se, turn);
    const run = Promise.resolve().then(() => adapter.deliver(this.s.sessions[sessionId], message, ctx));
    turn.exited = run.then(
      () => {},
      () => {},
    );
    run.then(
      () => this.endTurn(turn, null),
      (err) => this.endTurn(turn, err),
    );
    turn.exited.then(() => this.turnExited(turn));
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
      mcpUrl: `${this.config.origin}/mcp?session=${encodeURIComponent(turn.sessionId)}&turn=${turn.token}`,
      persona,
      project: rt.s.projects[thread?.projectId] ?? null,
      thread: { id: turn.threadId, title: thread?.title ?? '', kind: thread?.kind ?? 'thread' },
      handles: rt.handles(),
      room: rt.roomOf(turn.threadId, se0),
      /** What the adapter saved for this session last time, such as its own session id. */
      state: { ...(se0.backendState ?? {}) },
      saveState(patch) {
        const s = se();
        if (s) rt.updateSession(s.id, { backendState: { ...(s.backendState ?? {}), ...patch } });
      },
      /** Where an attachment can be read on disk, or null. */
      pathOf: (a) => rt.attachmentPath(turn.threadId, a),
      /** Asks the person in the thread; resolves to { allow, message?, updatedInput?, updatedPermissions? }. */
      askPermission: (req) => rt.requestPermission(turn.sessionId, req),
      /** Permission rules the person allowed for this turn only, after a refusal (Claude Code rule syntax). */
      allowOnce: [...turn.allowOnce],
      /** Rules the person made for this conversation only (#66): { allow, ask, deny }, passed every turn. */
      rules: { allow: [...(se0.rules?.allow ?? [])], ask: [...(se0.rules?.ask ?? [])], deny: [...(se0.rules?.deny ?? [])] },
      /** Folders the person added for this conversation (#66), passed as --add-dir / additionalDirectories. */
      addDirs: [...(se0.addDirs ?? [])],
      /** The adapter says how to name a subagent from its id (a prompt’s agent id), so its prompt names it. */
      subagentNames(fn) {
        turn.subagentName = fn;
      },
      /**
       * The adapter hands over what it can change while the turn runs, such as { setPermissionMode(mode) }. Each
       * resolves to true when the change took effect now.
       */
      control(c) {
        turn.control = c;
      },
      /**
       * The agent’s skills and commands (#67), from init (names) or the SDK’s supportedCommands() (with descriptions
       * and argument hints): [{ name, description?, argumentHint?, skill? }]. Kept on the session for the / menu.
       */
      commands(list) {
        if (live()) rt.recordCommands(turn.sessionId, list);
      },
      /**
       * A background job the agent started (#129): { id, toolUseId, label, command, outputFile, state: 'running' }, then
       * { id, state: 'done' | 'failed' | 'stopped' } when it ends, or { id, kept: true, pgid, groups } when Stop kept it
       * running: groups are the process groups it may be in, with their leaders' command lines (#164).
       * Taken after the turn ends too, since a job outlives its turn.
       */
      job(j) {
        rt.recordJob(turn, j);
      },
      /** The backend refused a tool call without asking: { toolUseId, tool, input, label, reason, reasonType, who }. */
      denied(d) {
        if (!live()) return;
        rt.ledger.denied(turn, d.toolUseId);
        rt.recordDenial(turn, d);
      },
      // For the work ledger (#132): each tool call with its whole input, before it runs ({ id, name, input, who });
      // what it returned ({ id, isError, text, result: the tool’s own record, vcsCwd }); a background task’s end
      // ({ toolUseId, status, summary, outputFile }); and the process’s running spend ({ key, costUsd, tokens }).
      toolUse(u) {
        if (live()) rt.ledger.toolUse(turn, u);
      },
      toolResult(r) {
        if (live()) rt.ledger.toolResult(turn, r);
      },
      taskEnded(t) {
        if (live()) rt.ledger.taskEnded(turn, t);
      },
      usage(u) {
        if (live()) rt.ledger.usage(turn, u);
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
      // who: the subagent that took the step, and parent: the step that started it, so the list nests it (#73); detail:
      // why it failed, the whole thought or narration, or what a subagent returned; kind: 'thought', 'said' (a
      // subagent’s narration) or 'agent' (a subagent’s own step); job: the id of the background job it started (#129).
      activity({
        id,
        label,
        state = 'running',
        ms = null,
        who = null,
        parent = /** @type {string|null} */ (null),
        detail = null,
        kind = null,
        job = /** @type {string|null} */ (null),
      }) {
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
          ...(typeof parent === 'string' && parent ? { parent: parent.slice(0, 100) } : {}),
          ...(detail ? { detail: String(detail).slice(0, 1200) } : {}),
          ...(STEP_KINDS.has(kind) ? { kind } : {}),
          ...(typeof job === 'string' && job ? { job: job.slice(0, 60) } : {}),
        };
        if (i >= 0) turn.steps[i] = { ...turn.steps[i], ...step };
        else turn.steps.push(step);
        if (turn.first) rt.patchItem(turn.threadId, turn.first, { activity: { steps: [...turn.steps] } });
        const s = se();
        // A thought or a subagent’s narration is in the list, but it isn’t a tool call.
        if (kind === 'thought' || kind === 'said') return;
        const calls = [{ name: step.label, state: step.state, ms: step.ms }, ...s.toolCalls.filter((c) => c.name !== step.label)].slice(0, 5);
        // A subagent’s step is its own: it moves its arc, not the agent’s state or step (#189).
        const own = state === 'running' && !(i >= 0 ? turn.steps[i] : step).who;
        rt.updateSession(turn.sessionId, {
          state: own ? 'tool' : s.state,
          toolCalls: calls,
          toolCount: s.toolCount + (i >= 0 ? 0 : 1),
          currentStep: own ? step.label : s.currentStep,
        });
      },
      status(patch) {
        if (!live()) return;
        const allowed = {};
        if (patch.state && ['think', 'gen', 'tool'].includes(patch.state)) allowed.state = patch.state;
        if (typeof patch.ctx === 'number') allowed.ctx = Math.max(0, Math.min(100, Math.round(patch.ctx)));
        if (Array.isArray(patch.subagents))
          // Each with what it was asked, its step now, its latest narration and the subagent that started it (#73).
          allowed.subagents = patch.subagents.slice(0, 12).map((x) => ({
            ...(typeof x.id === 'string' && x.id ? { id: x.id.slice(0, 100) } : {}),
            name: String(x.name).slice(0, 40),
            state: x.state,
            ctx: Math.max(0, Math.min(100, +x.ctx || 0)),
            doing: x.doing ? String(x.doing).slice(0, 120) : '',
            ...(x.thinking === true ? { thinking: true } : {}),
            ...(x.asked ? { asked: String(x.asked).slice(0, 120) } : {}),
            ...(x.said ? { said: String(x.said).slice(0, 200) } : {}),
            ...(x.since === true ? { since: true } : {}),
            ...(typeof x.parent === 'string' && x.parent ? { parent: x.parent.slice(0, 100) } : {}),
            ...(x.bg === true ? { bg: true } : {}),
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
      /**
       * What the backend reported about the run, kept on the session, bounded:
       * - mcpServers, the MCP servers its init listed with their status ([{ name, status, source? }]), as
       *   se.mcpServers = { at, servers }, for the persona sheet’s list (GET /api/mcp-servers);
       * - model, the model that answered, as se.lastModel, and effort, the effort the turn was started with, as
       *   se.lastEffort (#60): the header shows them, marked when they differ from the persona’s setting.
       */
      reported(r) {
        if (!live() || !r) return;
        /** @type {any} */
        const patch = {};
        if (typeof r.model === 'string' && r.model.trim()) patch.lastModel = r.model.trim().slice(0, 100);
        if (EFFORT_LEVELS.includes(r.effort)) patch.lastEffort = r.effort;
        if (Object.keys(patch).length) rt.updateSession(turn.sessionId, patch);
        if (Array.isArray(r.mcpServers))
          rt.updateSession(turn.sessionId, {
            mcpServers: {
              at: Date.now(),
              servers: r.mcpServers
                .filter((x) => x && typeof x.name === 'string' && x.name)
                .slice(0, 100)
                .map((x) => ({
                  name: x.name.slice(0, 200),
                  status: String(x.status ?? '').slice(0, 20),
                  ...(typeof x.source === 'string' ? { source: x.source.slice(0, 20) } : {}),
                })),
            },
          });
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

  /** The turn’s work is recorded (#132), then its last reply, or its last block, gets the list that leads to it (#195). */
  endWork(turn, status) {
    return this.ledger.endTurn(turn, { status }).then(() => {
      const line = turn.work ? turnLine(this.ledger.entries(turn.work.convId), turn.id) : null;
      const last = this.store.items(turn.threadId).findLast((x) => x.turnId === turn.id && (x.kind === 'agent' || (x.kind === 'block' && x.valid)));
      if (line && last) this.patchItem(turn.threadId, last.id, { work: line, workTurn: turn.id });
    });
  }

  endTurn(turn, err) {
    if (turn.closed) return;
    turn.closed = true;
    this.turns.delete(turn.sessionId);
    this.settleSubagentSteps(turn);
    this.endWork(turn, !err ? 'done' : err.name === 'AbortError' ? 'stopped' : 'failed');
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
    // “Summarize back”: the reply goes to the conversation the topic branched from. The turn’s replies are what
    // was sent, so they show “Sent to the conversation” and can’t be sent again (#93).
    if (turn.summarizeTo && !err && turn.said.trim()) {
      this.shareText(turn.summarizeTo, { fromThreadId: turn.threadId, handle: se.handle, text: turn.said, summary: true });
      for (const it of items)
        if (it.turnId === turn.id && it.kind === 'agent' && it.text && !it.sharedAt) this.patchItem(turn.threadId, it.id, { sharedAt: Date.now() });
    }
    // Posted or not, the summary isn’t pending any more, so Summarize back works again. Any turn ending clears
    // one a restart left behind, too.
    this.clearSummaryPending(turn.threadId);
    if (err && err.name !== 'AbortError') {
      // Its progress steps still running show as stalled, as at any turn’s end (#98).
      this.stallLeftRunning(turn, se, 'failed');
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
      this.patchItem(turn.threadId, target, { status: 'failed', error: message, retry: turn.retry ?? null, asked: askedOf(turn) });
      this.updateSession(se.id, {
        state: 'failed',
        needs: { kind: 'failed', itemId: target, text: message, ...this.awayFrom(se, turn.threadId) },
        sideTurn: null,
        subagents: [],
        currentStep: 'Failed',
        finishedAt: Date.now(),
        stopAsk: null,
      });
      this.notify('blocking', se, `@${se.handle}’s reply failed`, message, turn.threadId);
      // A wake that waited for this turn still goes: with no forks, it was promised an answer (#228). Your own
      // queued messages wait, as before, for you to see the failure.
      this.takePending(se, turn, 'wakes');
      return;
    }
    // An app-check turn that ended without a new version: show the app with a note instead of waiting forever.
    if (turn.kind === 'app-check') {
      for (const app of Object.values(this.s.apps))
        if (app.sessionId === se.id && app.check.status === 'fixing') this.store.emit('app', { ...app, check: { ...app.check, status: 'note' } });
    }
    // Only this turn’s asking blocks make the agent need you. Older ones you left open stay open, and the
    // client shows them quietly (“1 open review”), so moving on clears needs-you (#69). A turn you didn’t start
    // (a lint or app-check pass, another agent’s wake or review) isn’t moving on: the block it was waiting on still counts.
    const open = items.filter(
      (it) => it.kind === 'block' && it.turnId === turn.id && it.sessionId === se.id && it.valid && ASKING.has(it.block.type) && !it.answered,
    );
    const waiting = se.needs?.kind === 'block' && !turn.movesOn ? items.find((it) => it.id === se.needs?.itemId) : null;
    if (!open.length && waiting && !waiting.answered) open.push(waiting);
    const last = [...items].reverse().find((it) => it.kind === 'agent' && it.sessionId === se.id && it.text);
    const viewing = this.isViewing(turn.threadId);
    const topic = turn.threadId !== se.threadId && this.s.threads[turn.threadId]?.kind === 'topic' ? this.s.threads[turn.threadId] : null;
    const refused = items.filter((it) => it.kind === 'denial' && it.turnId === turn.id && it.status === 'open');
    const askedTool = items.filter((it) => it.kind === 'toolask' && it.turnId === turn.id && it.status === 'open').at(-1);
    const needs = open.length
      ? {
          kind: 'block',
          itemId: open.at(-1).id,
          text: open.at(-1).block.title ?? clip(open.at(-1).block.prompt ?? open.at(-1).block.fallback, 120),
          ...(open.at(-1) === waiting ? { threadId: se.needs?.threadId } : this.awayFrom(se, turn.threadId)),
        }
      : refused.length
        ? {
            kind: 'denial',
            itemId: refused.at(-1).id,
            text: `${refused.length === 1 ? 'A step was' : `${refused.length} steps were`} refused: ${refused.at(-1).summary}`,
            ...this.awayFrom(se, turn.threadId),
          }
        : askedTool
          ? { kind: 'toolask', itemId: askedTool.id, text: `@${se.handle} asks you to turn on “${askedTool.label}”`, ...this.awayFrom(se, turn.threadId) }
          : se.needs?.kind === 'hop'
            ? se.needs
            : null;
    const mentionsYou = /(^|\W)@you\b/i.test(turn.said);
    this.updateSession(se.id, {
      state: needs ? 'needs' : 'idle',
      needs,
      sideTurn: null,
      glimpse: '',
      subagents: [],
      currentStep: needs ? 'Waiting for you' : `Idle since ${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })}`,
      lastMessage: last ? clip(last.text) : se.lastMessage,
      finishedAt: Date.now(),
      // A reply in a topic thread counts on the thread, not the conversation it answers from (#228).
      unread: topic ? se.unread : viewing ? 0 : se.unread + (turn.said || open.length ? 1 : 0),
      stopAsk: null,
    });
    if (needs && (needs.kind === 'block' || needs.kind === 'denial' || needs.kind === 'toolask'))
      this.notify('blocking', se, `@${se.handle} needs you`, needs.text, needs.threadId);
    else if (mentionsYou && !viewing) this.notify('info', se, `@${se.handle} mentioned you`, clip(turn.said, 120), turn.threadId);
    else if (turn.said && !viewing) this.notify('info', se, `@${se.handle} finished`, clip(turn.said, 120), turn.threadId);

    // The checks: what this turn sent, as problems, which go back to the agent in one lint turn. A lint turn is
    // never linted again, so this can’t loop; one that only called tools ends as a note instead of a reply.
    const stalled = this.stallSteps(turn, se);
    if (turn.kind === 'lint') this.quietLint(turn, se);
    else this.endLint(turn, [...this.checkTurn(turn, se), ...stalled]);
    this.lastTurn.set(se.id, turn.id);
    if (topic && !viewing && (turn.said || open.length)) this.putThread({ ...this.s.threads[topic.id], unread: (this.s.threads[topic.id].unread ?? 0) + 1 });
    if (turn.threadId !== se.threadId) settleThread(this, turn.threadId);

    // An agent that @-mentions another agent wakes it.
    // Mentioning the agent you’re replying to isn’t a new wake: the reply already goes back to it.
    // Mentioning the agent that just wrote to you wakes it only if you ask it to check again.
    const replyTo = turn.replyTo ? this.s.sessions[turn.replyTo]?.handle?.toLowerCase() : null;
    for (const h of parseMentions(turn.said, this.handles())) {
      const hl = h.toLowerCase();
      if (hl === se.handle.toLowerCase() || hl === replyTo) continue;
      if (hl === turn.from && !/again|once more|loop/i.test(turn.said)) continue;
      // Its turn has ended, so where it spoke comes from the turn: an answer goes back to a topic thread it spoke in.
      const r = this.agentWake(se.id, h, turn.said, { replyIn: turn.threadId !== se.threadId ? turn.threadId : null });
      if (!r.ok && !r.waiting) this.tellAgent(se.id, `Your mention of @${h} woke no one: ${r.message}`);
    }
    // A reply to an agent that woke this one goes back to it.
    if (turn.replyTo && this.s.sessions[turn.replyTo] && !this.s.sessions[turn.replyTo].archived) {
      this.deliver(turn.replyTo, { kind: 'agent', from: `@${se.handle}`, text: turn.said || '(no reply)' }, { threadId: turn.replyIn });
      this.recordAgentMessage(se.id, 'to', this.s.sessions[turn.replyTo].handle, turn.said);
      this.recordAgentMessage(turn.replyTo, 'from', se.handle, turn.said);
    }
    this.takePending(se, turn, true);
  }

  /**
   * What waited for a turn that ended: the next message, with the rest behind it; with none, the queues (drain), or
   * only agents’ wakes waiting there (drain: 'wakes').
   */
  takePending(se, turn, drain) {
    const next = turn.pending.shift();
    if (next) {
      this.deliver(se.id, next.message, { replyTo: next.replyTo, summarizeTo: next.summarizeTo, threadId: next.threadId });
      const t = this.turns.get(se.id);
      if (t) t.pending.push(...turn.pending);
    } else if (drain) this.drainQueues(se.id, turn.threadId, drain === 'wakes');
  }

  /**
   * The thread a session’s ask is in, when that isn’t its own: { threadId } to spread into its needs, so the overview
   * and ⌃J go to the side thread where the card is (#121).
   * @param {any} se @param {string} threadId
   */
  awayFrom(se, threadId) {
    return threadId && threadId !== se.threadId ? { threadId } : {};
  }

  /**
   * The queues waiting on this session: the thread its turn was in, and any other (its conversation, a side thread)
   * whose next message is for it. A session answers in more than one thread now (#110).
   */
  drainQueues(sessionId, threadId, wakesOnly = false) {
    const ids = new Set(wakesOnly ? [] : [threadId]);
    for (const t of Object.values(this.s.threads))
      if (t.queue?.some((q) => q.sessionIds.includes(sessionId) && (!wakesOnly || q.kind === 'wake'))) ids.add(t.id);
    for (const id of ids) this.drainQueue(id, wakesOnly);
  }

  /**
   * Stop ends this agent’s turn and its subagents. Agents it woke keep running. Its process gets SIGINT, then SIGKILL,
   * and the session shows as stopping until it has exited: its next turn waits for that (#126).
   * jobs: what happens to the background jobs the turn started (#129): 'stop' them with it, or 'keep' them running,
   * each with its own Stop.
   * by: 'shutdown' when Postbox stops it as it shuts down, which the agent hears in those words.
   * @param {string} sessionId @param {{ silent?: boolean, jobs?: 'stop' | 'keep', by?: 'you' | 'shutdown' }} [opts]
   */
  stop(sessionId, { silent = false, jobs = 'stop', by = 'you' } = {}) {
    const turn = this.turns.get(sessionId);
    if (!turn) return false;
    const keep = jobs === 'keep' ? this.runningJobs(sessionId, turn.id) : [];
    turn.keepJobs = new Set(keep.map((j) => j.id));
    this.exiting.set(sessionId, { turn, held: [], silent });
    // The adapter reads which jobs to keep from the reason; anything else only sees that the turn was aborted.
    turn.abort.abort(Object.assign(new Error('Stopped by you.'), { name: 'AbortError', keepJobs: keep.map((j) => ({ id: j.id, command: j.command })) }));
    turn.closed = true;
    this.turns.delete(sessionId);
    this.settleSubagentSteps(turn);
    this.endWork(turn, 'stopped');
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
    this.updateSession(sessionId, { state: 'stopping', subagents: [], currentStep: 'Stopping', finishedAt: Date.now(), stopAsk: null });
    // Progress steps running as you keep its jobs running may follow one of them: they run on with it (#129).
    if (keep.length) this.updateSession(sessionId, { heldSteps: { threadId: turn.threadId, keys: this.runningProgress(turn.threadId, sessionId) } });
    // Its progress steps still running show as stalled, as at any turn’s end (#98); you stopped it, so no lint turn.
    const se = this.s.sessions[sessionId];
    if (se) this.stallLeftRunning(turn, se, by === 'shutdown' ? 'shutdown' : 'stopped');
    // A process that never exits mustn’t hold the session for good: after a while, the next turn starts anyway.
    setTimeout(() => {
      if (this.exiting.get(sessionId)?.turn !== turn) return;
      console.error(`@${se?.handle ?? sessionId}’s stopped turn hadn’t ended after ${STOP_WATCHDOG_MS / 1000} s, so its next turn starts anyway.`);
      this.turnExited(turn);
    }, STOP_WATCHDOG_MS).unref?.();
    // A stopped summary (or one queued behind the turn, which goes with it) isn’t coming (#93), in a topic thread too.
    // A reply from an agent it woke, waiting behind the turn, goes with it: it hears at its next turn what it said.
    this.clearSummaryPending(turn.threadId);
    for (const p of turn.pending) {
      if (p.summarizeTo && p.threadId) this.clearSummaryPending(p.threadId);
      if (p.message.kind === 'agent' && !p.replyTo && se)
        this.tellAgent(sessionId, `${p.message.from}’s reply came while your turn was stopped: “${clip(p.message.text ?? '', 300)}”`);
    }
    // You stopped it: wakes queued for it go too, and their agents are told (#228). Send now keeps them (silent).
    if (!silent && se) dropWakes(this, se);
    return true;
  }

  /**
   * A turn’s adapter is done, which for a real backend means its process has exited. Its background jobs that nothing
   * reported the end of went with it, and a stopped session takes what waited for it: the messages sent meanwhile,
   * then the queue.
   */
  turnExited(turn) {
    this.settleJobs(turn);
    const ex = this.exiting.get(turn.sessionId);
    if (ex?.turn !== turn) return;
    this.exiting.delete(turn.sessionId);
    const se = this.s.sessions[turn.sessionId];
    if (!se) return;
    // Something else may have set the state meanwhile (archive, an answered card); “Stopping” goes either way.
    if (se.state === 'stopping' || se.currentStep === 'Stopping')
      this.updateSession(se.id, { state: se.state === 'stopping' ? 'idle' : se.state, currentStep: 'Stopped by you', finishedAt: Date.now(), sideTurn: null });
    else if (se.sideTurn) this.updateSession(se.id, { sideTurn: null });
    const held = se.archived || se.deleting ? [] : ex.held;
    // Shutting down: your messages wait in their thread’s queue, which a restart keeps, rather than starting a CLI.
    if (this.closing) {
      for (const h of held.filter((x) => x.message.kind === 'user')) {
        const t = this.s.threads[h.threadId ?? se.threadId];
        const q = { id: newId('q'), text: h.message.text ?? '', attachments: h.message.attachments ?? [], sessionIds: [se.id], at: Date.now() };
        if (t) this.putThread({ ...t, queue: [...(t.queue ?? []), q] });
      }
      return;
    }
    for (const h of held) this.deliver(se.id, h.message, { replyTo: h.replyTo, summarizeTo: h.summarizeTo, threadId: h.threadId });
    if (!held.length && !ex.silent) this.drainQueues(se.id, turn.threadId);
  }

  /**
   * Stop from the page (#129): with background jobs running, it asks first whether to stop them too, and the ask
   * shows in the conversation (se.stopAsk) until you answer, dismiss it, or the turn ends.
   * turnId: the turn the ask was about. An answer to an ask about a turn that has ended since stops nothing.
   * subagent: End on that subagent’s row instead (#229), which tells the agent to stop it.
   * @param {string} sessionId @param {{ jobs?: 'stop' | 'keep' | null, turnId?: string | null, subagent?: string | null }} [choice]
   */
  requestStop(sessionId, { jobs = null, turnId = null, subagent = null } = {}) {
    if (subagent) return endSubagent(this, sessionId, String(subagent));
    const se = this.session(sessionId);
    const turn = this.turns.get(sessionId);
    if (!turn) return { stopped: false };
    if (turnId && turnId !== turn.id) return { stopped: false, ended: true };
    const running = this.runningJobs(sessionId, turn.id);
    if (running.length && jobs !== 'stop' && jobs !== 'keep') {
      const ask = { jobs: running.length, text: stopAskText(se.handle, running.length), turnId: turn.id };
      this.updateSession(sessionId, { stopAsk: { ...ask, at: Date.now() } });
      return { ask };
    }
    return { stopped: this.stop(sessionId, { jobs: jobs === 'keep' ? 'keep' : 'stop' }) };
  }

  /** You chose not to stop after all: the ask goes away, and the agent carries on. */
  dismissStopAsk(sessionId) {
    this.session(sessionId);
    this.updateSession(sessionId, { stopAsk: null });
  }

  // ── Background jobs (#129) ─────────────────────────────────────────────────────────

  /** A turn’s background jobs still running under its CLI (not those Postbox kept running after an earlier Stop). */
  runningJobs(sessionId, turnId) {
    return (this.s.sessions[sessionId]?.jobs ?? []).filter((j) => j.turnId === turnId && j.state === 'running' && !j.kept);
  }

  /** What the adapter reports about a background job (ctx.job), bounded. */
  recordJob(turn, j) {
    const se = this.s.sessions[turn.sessionId];
    if (!se || !j || typeof j.id !== 'string' || !j.id) return;
    const id = j.id.slice(0, 60);
    const jobs = se.jobs ?? [];
    const old = jobs.find((x) => x.id === id);
    if (!old) {
      if (j.state !== 'running') return;
      const job = {
        id,
        sessionId: se.id,
        turnId: turn.id,
        threadId: turn.threadId,
        itemId: turn.first,
        toolUseId: String(j.toolUseId ?? '').slice(0, 100),
        label: clipText(String(j.label ?? 'Background job'), 200),
        // Whole, up to a bound: Postbox finds the job’s process by its command.
        command: String(j.command ?? '').slice(0, 8000),
        outputFile: typeof j.outputFile === 'string' && j.outputFile ? j.outputFile.slice(0, 1000) : null,
        startedAt: Date.now(),
        state: 'running',
      };
      // At the bound, the oldest job Postbox didn’t keep goes first: a kept one has no other record.
      const all = [...jobs, job];
      const drop = all.length > MAX_JOBS ? all.find((x) => !x.kept) : null;
      this.updateSession(se.id, { jobs: drop ? all.filter((x) => x !== drop) : all });
      return;
    }
    const groups = j.kept === true ? keptGroupsOf(j) : [];
    if (groups.length) {
      this.updateSession(se.id, { jobs: jobs.map((x) => (x.id === id ? { ...x, kept: true, pgid: groups[0].pgid, groups } : x)) });
      // Postbox couldn’t tell which of the turn’s processes was the job, so it kept them all (#164): say so.
      const unsure = groups.length > 1 ? keepUnsure(groups.length) : null;
      if (unsure) this.setJobStep(old, { detail: unsure });
      this.ledger.jobUpdate(old, { kept: true });
      // Its CLI is gone, so nothing would tell the agent: its next turn hears it’s still running.
      // A step that follows it reads as running on (#129): the agent leaves it running, rather than closing it as failed.
      this.tellAgent(
        se.id,
        `Your background job ${id} (\`${clipText(old.command, 200)}\`) is still running: the person kept it running when your last turn was stopped.${unsure ? ` ${unsure}` : ''}${old.outputFile ? ` Its output is in ${old.outputFile}.` : ''} They can stop it from the conversation. If a progress step follows it, leave that step running while the job runs: when it ends, Postbox tells you on your next turn.`,
      );
      this.watchKept();
      return;
    }
    if (typeof j.state === 'string' && j.state !== 'running') {
      const lost = turn.keepJobs.has(id) && !old.kept;
      this.endJob(se.id, id, old.stopping || lost ? 'stopped' : j.state, lost ? KEEP_LOST : null);
    }
  }

  /**
   * A job ended: it leaves the session’s list, and its step shows how.
   * @param {string} sessionId @param {string} jobId @param {string} state @param {string|null} [detail]
   * @param {{ by?: 'you' | null }} [opts]
   */
  endJob(sessionId, jobId, state, detail = null, { by = null } = {}) {
    const se = this.s.sessions[sessionId];
    const job = se?.jobs?.find((j) => j.id === jobId);
    if (!se || !job) return;
    // Work says how it ended too: its turn may have ended thinking it was still running (#164).
    this.ledger.jobUpdate(job, { state, by });
    this.updateSession(sessionId, { jobs: se.jobs.filter((j) => j.id !== jobId) });
    if (this.keptPoll && !this.keptJobs().length) {
      clearInterval(this.keptPoll);
      this.keptPoll = null;
    }
    // A kept job’s step loses what it said while running (keepUnsure); another’s keeps why its CLI said it failed.
    this.setJobStep(job, { state: STEP_STATES.has(state) ? state : 'done', ms: Date.now() - job.startedAt, ...(detail || job.kept ? { detail } : {}) });
    // A job Postbox kept running ended after its CLI had gone, so the agent hears it on its next turn.
    if (job.kept)
      this.tellAgent(
        sessionId,
        `Your background job ${job.id} (\`${clipText(job.command, 200)}\`) ${by === 'you' ? 'was stopped by the person' : 'has ended'}.${job.outputFile ? ` Its output is in ${job.outputFile}.` : ''}`,
      );
    // The last job kept running has ended: the progress steps held running with it (stop) stall now, as they would have
    // when its turn ended, or when the turn running now ends (stallSteps).
    const now = this.s.sessions[sessionId];
    const held = now?.heldSteps;
    if ((job.kept || detail === KEEP_LOST) && held && !(now.jobs ?? []).some((j) => j.kept)) {
      this.updateSession(sessionId, { heldSteps: null });
      const problems = this.turns.has(sessionId) ? [] : this.stallSteps({ threadId: held.threadId }, this.s.sessions[sessionId]);
      if (problems.length)
        this.tellAgent(
          sessionId,
          `Your background job ${job.id} ended while progress steps were running:\n${problems.map((p) => `- Block “${p.scope.title ?? p.scope.id}” (id ${p.scope.id}): ${p.message}`).join('\n')}`,
        );
    }
  }

  /**
   * A subagent that worked in the background, and its own calls, still running when its turn ends: nothing will say
   * how they ended now (Stop, or its CLI exited without saying), so they read as stopped (#73).
   */
  settleSubagentSteps(turn) {
    const open = new Set((turn.steps ?? []).filter((s) => s.kind === 'agent' && s.state === 'running').map((s) => s.id));
    if (!open.size) return;
    for (let grew = true; grew; ) {
      grew = false;
      for (const s of turn.steps)
        if (s.state === 'running' && !s.job && s.parent && open.has(s.parent) && !open.has(s.id)) {
          open.add(s.id);
          grew = true;
        }
    }
    turn.steps = turn.steps.map((s) => (open.has(s.id) ? { ...s, state: 'stopped', detail: 'its turn ended before it finished' } : s));
    if (turn.first) this.patchItem(turn.threadId, turn.first, { activity: { steps: [...turn.steps] } });
  }

  /** The keys (`item:step`) of a session’s progress steps running in a thread. */
  runningProgress(threadId, sessionId) {
    return this.store
      .items(threadId)
      .filter((it) => it.kind === 'block' && it.valid && it.sessionId === sessionId && it.block.type === 'progress')
      .flatMap((it) => it.block.steps.filter((s) => s.state === 'running').map((s) => `${it.id}:${s.id}`));
  }

  /** Changes a job’s step: in its turn while that runs, else in the reply it’s on. */
  setJobStep(job, patch) {
    const live = this.turns.get(job.sessionId);
    const turn = live?.id === job.turnId ? live : null;
    const steps = turn ? turn.steps : this.store.item(job.threadId, job.itemId)?.activity?.steps;
    if (!Array.isArray(steps)) return;
    const next = steps.map((st) => (st.id === job.toolUseId ? { ...st, ...patch } : st));
    if (turn) turn.steps = next;
    if (job.itemId) this.patchItem(job.threadId, job.itemId, { activity: { steps: next } });
  }

  /** Jobs nothing reported the end of went with their CLI (SIGKILL, or a crash), unless Postbox kept them running. */
  settleJobs(turn) {
    for (const j of [...(this.s.sessions[turn.sessionId]?.jobs ?? [])])
      if (j.turnId === turn.id && j.state === 'running' && !j.kept) this.endJob(turn.sessionId, j.id, 'stopped', turn.keepJobs.has(j.id) ? KEEP_LOST : null);
  }

  /** Context the agent reads at the start of its next turn, as a Postbox notice. */
  tellAgent(sessionId, text) {
    const se = this.s.sessions[sessionId];
    if (se) this.updateSession(sessionId, { context: [...(se.context ?? []), `[Postbox] ${text}`].slice(-20) });
  }

  /** The kept jobs, everywhere. */
  keptJobs() {
    return Object.values(this.s.sessions).flatMap((se) => (se.jobs ?? []).filter((j) => j.kept && keptGroupsOf(j).length));
  }

  /** Checks on the jobs Postbox kept running, until none is left: one whose process group is gone has ended. */
  watchKept() {
    if (this.keptPoll) return;
    this.keptPoll = setInterval(() => this.pollKept(), KEPT_POLL_MS);
    this.keptPoll.unref?.();
  }
  async pollKept() {
    if (!this.keptJobs().length) return;
    const procs = await this.listProcesses().catch(() => null);
    if (!procs) return;
    for (const j of this.keptJobs()) if (!liveGroups(j, procs).length) this.endJob(j.sessionId, j.id, 'done');
    if (!this.keptJobs().length && this.keptPoll) {
      clearInterval(this.keptPoll);
      this.keptPoll = null;
    }
  }

  /** Stops a session’s kept jobs, when it’s deleted for good or Postbox shuts down: nothing else would know of them. */
  async stopKeptJobs(sessionIds, why) {
    const jobs = this.keptJobs().filter((j) => sessionIds.includes(j.sessionId));
    if (!jobs.length) return;
    const procs = await this.listProcesses().catch(() => []);
    for (const j of jobs) {
      for (const g of liveGroups(j, procs)) stopPgid(g.pgid, { kill: this.signalProcess });
      this.endJob(j.sessionId, j.id, 'stopped', why);
    }
  }

  /**
   * A background job’s own Stop (#129). One Postbox kept running is signaled by its process group; one still under its
   * agent’s CLI is found there by the adapter, and the CLI reports how it ended.
   */
  async stopJob(sessionId, jobId) {
    const se = this.session(sessionId);
    const job = (se.jobs ?? []).find((j) => j.id === jobId);
    if (!job) throw httpError(409, 'That background job already ended.');
    if (job.kept) {
      // Only the groups still the job’s: one that ended may have left its id to another process.
      for (const g of liveGroups(job, await this.listProcesses().catch(() => []))) stopPgid(g.pgid, { kill: this.signalProcess });
      this.endJob(sessionId, jobId, 'stopped', null, { by: 'you' });
      return { ok: true };
    }
    const turn = this.turns.get(sessionId);
    const stopJob = turn?.id === job.turnId ? turn.control?.stopJob : null;
    if (typeof stopJob !== 'function') throw httpError(409, `Postbox can’t reach that job’s process. Stop @${se.handle} to stop it.`);
    const mark = (stopping) =>
      this.updateSession(sessionId, { jobs: (this.s.sessions[sessionId]?.jobs ?? []).map((j) => (j.id === jobId ? { ...j, stopping } : j)) });
    mark(true);
    const pgid = await stopJob({ id: job.id, command: job.command });
    if (!pgid) {
      mark(false);
      throw httpError(409, `Postbox couldn’t find that job’s process. Stop @${se.handle} to stop it.`);
    }
    return { ok: true };
  }

  /**
   * When Postbox shuts down: every turn’s CLI runs in its own process group, and so do the jobs Postbox kept running,
   * so they’d outlive it. Each is stopped, jobs too, and this waits for the turns’ processes to exit, up to graceMs.
   * @param {{ graceMs?: number }} [opts]
   */
  async stopTurns({ graceMs = 4000 } = {}) {
    this.closing = true;
    for (const id of [...this.turns.keys()]) this.stop(id, { silent: true, by: 'shutdown' });
    await this.stopKeptJobs(Object.keys(this.s.sessions), 'Postbox stopped it as it shut down.');
    /** @type {NodeJS.Timeout|undefined} */
    let timer;
    const late = new Promise((r) => {
      timer = setTimeout(r, graceMs);
    });
    await Promise.race([Promise.all([...this.exiting.values()].map((x) => x.turn.exited)), late]);
    clearTimeout(timer);
  }

  /** After a restart, no background job Postbox knew of is its to track any more. */
  expireStaleJobs() {
    for (const se of Object.values(this.s.sessions))
      for (const j of se.jobs ?? [])
        this.endJob(se.id, j.id, 'stopped', 'Postbox restarted while it ran. If Postbox didn’t shut down cleanly, it may still be running.');
  }

  /** Retry a failed reply: sends the same message again. */
  retry(threadId, itemId) {
    const it = this.store.item(threadId, itemId);
    if (it?.status !== 'failed') throw httpError(409, 'Only a failed reply can be retried.');
    const prior = [...this.store.items(threadId)].reverse().find((x) => x.kind === 'user' && x.at <= it.at);
    this.patchItem(threadId, itemId, { status: 'retried' });
    this.updateSession(it.sessionId, { needs: null, state: 'idle' });
    if (it.asked) this.deliver(it.sessionId, { ...it.asked.message, retry: true }, { replyTo: it.asked.replyTo, summarizeTo: it.asked.summarizeTo, threadId });
    // A failed reply stored before #151 kept nothing of what it was asked: the person’s last message is the best guess.
    else this.deliver(it.sessionId, { kind: 'user', text: prior?.text ?? '', attachments: prior?.attachments ?? [], retry: true }, { threadId });
  }

  // ── Agents waking agents ───────────────────────────────────────────────────────────

  agentWake(fromSessionId, handle, text, opts) {
    return agentWake(this, fromSessionId, handle, text, opts);
  }
  sideSession(side, personaId, by) {
    return sideSession(this, side, personaId, by);
  }
  resolveHop(threadId, itemId, allow) {
    return resolveHop(this, threadId, itemId, allow);
  }
  bumpSideLink(sideThreadId) {
    return bumpSideLink(this, sideThreadId);
  }
  recordAgentMessage(sessionId, dir, other, text) {
    return recordAgentMessage(this, sessionId, dir, other, text);
  }

  // ── Acting in blocks ───────────────────────────────────────────────────────────────

  act(threadId, itemId, action, values, revision) {
    return act(this, threadId, itemId, action, values, revision);
  }

  answerDelivered(threadId, message) {
    return answerDelivered(this, threadId, message);
  }

  unreadAnswer(sessionId, threadId, it, outcome = false) {
    return unreadAnswer(this, sessionId, threadId, it, outcome);
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
    // In a topic or side thread too, it joins the conversation: one session per agent there (#228).
    this.ensureSession(this.lineage(threadId).at(-1), p.id, { brief: it.proposal.description });
    this.addItem(threadId, { kind: 'system', variant: 'joined', to: p.handle });
    return { ok: true, personaId: p.id };
  }

  // ── Topic threads ──────────────────────────────────────────────────────────────────
  // Any message in a conversation can start a topic thread, as in Slack. Its agents are the conversation’s own, one
  // session each (#228): an agent answers there from that session, so it remembers the thread, and the conversation’s
  // other agents see the thread’s line, with a short summary, and read it if they choose. Nothing in it is posted in
  // the conversation unless you send it.

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
      // Who answers in it before anyone has spoken there (sendMessage): set below.
      woke: null,
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
    if (src) this.putThread({ ...this.s.threads[topic.id], woke: src.handle });
    return { threadId: topic.id };
  }

  /** “Send to conversation”: a message from a topic or side thread (#128) is posted in its conversation, for you and its agents. */
  shareToConversation(topicId, itemId) {
    const topic = this.thread(topicId);
    if (topic.kind !== 'topic' && topic.kind !== 'side') throw httpError(409, 'Only messages in a topic or side thread can be sent to the conversation.');
    const it = this.store.item(topicId, itemId);
    if (!it?.text) throw httpError(404, 'That reply has no text to send.');
    if (it.sharedAt) throw httpError(409, 'That reply is already in the conversation.');
    // Part of a summary still being written: the whole summary is posted when it’s done (#93).
    if ([...this.turns.values()].some((x) => x.id === it.turnId && x.summarizeTo))
      throw httpError(409, 'This reply is part of a summary that’s still being written. It’s posted in the conversation when it’s done.');
    this.patchItem(topicId, itemId, { sharedAt: Date.now() });
    return this.shareText(topic.parentId, { fromThreadId: topicId, handle: it.kind === 'user' ? null : it.handle, text: it.text });
  }

  /** “Summarize back”: the topic’s agent writes a short summary, which is posted in the conversation. */
  summarizeBack(topicId) {
    const topic = this.thread(topicId);
    if (topic.kind !== 'topic') throw httpError(409, 'Only a topic thread can be summarized back.');
    // The thread’s agent: the one that spoke last there, else the one it started with (#228).
    const p = threadPersona(this, topic);
    const se = p && this.sideSession(topic, p.id, 'you');
    if (!se) throw httpError(409, 'No agent is in this thread to summarize it.');
    // One at a time, so a second click or a second tab can’t post it twice (#93).
    if (this.summarizing(topicId)) throw httpError(409, 'A summary is already on its way. It’s posted in the conversation when it’s written.');
    // Kept on the thread for the panel’s button, until the turn ends or is stopped. A restart can leave it
    // behind an idle agent, which the panel treats as done; the check above looks at the turns themselves.
    this.putThread({ ...topic, summaryPending: { sessionId: se.id, at: Date.now() } });
    this.addItem(topicId, { kind: 'voice', text: 'Asked for a summary to send back to the conversation' });
    this.deliver(
      se.id,
      {
        kind: 'notice',
        text: 'Summarize this topic thread for the main conversation: what was decided, what changed, and anything still open. One short paragraph, no headings. It will be posted there as your summary.',
      },
      { summarizeTo: topic.parentId, threadId: topicId },
    );
    return { ok: true };
  }

  /** Whether a summarize turn is running or queued in a topic thread. */
  summarizing(topicId) {
    return (
      [...this.turns.values()].some((x) => (x.threadId === topicId && x.summarizeTo) || x.pending.some((p) => p.summarizeTo && p.threadId === topicId)) ||
      // One waiting for a stopped turn’s process to exit (#126).
      [...this.exiting.values()].some((x) => x.held.some((h) => h.summarizeTo && h.threadId === topicId))
    );
  }

  clearSummaryPending(topicId) {
    const t = this.s.threads[topicId];
    if (t?.summaryPending && !this.summarizing(topicId)) this.putThread({ ...t, summaryPending: null });
  }

  /**
   * Posts text from a topic or side thread in its conversation. The conversation’s agents read it at the start of
   * their next turn rather than being woken by it, so sharing never costs a turn. agent: the agent posted it with
   * bring_to_conversation, because the person asked it to (#128).
   */
  shareText(threadId, { fromThreadId, handle, text, summary = false, agent = false }) {
    const from = this.s.threads[fromThreadId];
    // The conversation’s agents read it at the start of their next turn, with everything else they missed.
    const it = this.addItem(threadId, { kind: 'shared', fromThreadId, fromTitle: from?.title ?? '', handle, text, summary, ...(agent ? { agent } : {}) });
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
    // Its first catch-up in a topic thread starts with the message the thread is about, unless it holds it already.
    const root = se.seenItem === null ? this.topicRootLine(se, t) : null;
    const lines = items
      .slice(at + 1)
      .filter((i) => i.id !== excludeId && i.sessionId !== se.id)
      .map((i) => this.describeItem(i, se))
      .filter(Boolean)
      // Its topic and side threads with something new, each a line it may read (#228); the person’s new reactions (#251).
      .concat(threadLines(this, se, items[at]?.at ?? 0), reactionLines(this, se, se.threadId));
    if (!lines.length) return root && `[Postbox] ${root}`;
    const kept = [];
    let size = 0;
    for (const line of lines.reverse()) {
      if (kept.length >= CATCH_UP_ITEMS || size + line.length > CATCH_UP_CHARS) break;
      kept.unshift(line);
      size += line.length;
    }
    const dropped = lines.length - kept.length;
    const where = t?.kind === 'room' ? 'this room' : t?.kind === 'topic' ? 'this thread' : 'this conversation';
    return `[Postbox] ${root ? `${root}\n\n` : ''}What happened in ${where} since your last turn${dropped ? ` (the last ${kept.length}; ${dropped} earlier ${dropped === 1 ? 'item is' : 'items are'} left out, and read_conversation has them)` : ''}:\n\n${kept.join('\n\n')}`;
  }

  /**
   * The message a topic thread started from, for an agent’s first turn there (#81, #228); null for anything else.
   */
  topicRootLine(se, t) {
    if (t?.kind !== 'topic') return null;
    const root = this.store.item(t.parentId, t.rootItemId);
    if (!root) return null;
    // The thread is about this message, so it gets more room than an item in the catch-up.
    const text = (s) => clipItem(s, 4000, root.id);
    const from = 'This thread started from';
    switch (root.kind) {
      case 'user':
        return `${from} your message: ${text(root.text)}${root.attachments?.length ? ` [attached: ${root.attachments.map((a) => a.name ?? a.path).join(', ')}]` : ''}`;
      case 'agent':
        return `${from} @${root.handle}’s message: ${text(root.text)}`;
      case 'block': {
        // The title names it; what it holds is the text an agent can quote (a draft, or a table’s rows) (#153).
        const b = root.block ?? {};
        const what = b.type === 'app' ? 'app' : b.type ? `${b.type} block` : 'block';
        const body = (root.valid && blockContent(root)) || String(b.fallback ?? root.fallback ?? '');
        return `${from} @${root.handle}’s ${what}${b.title ? ` “${clipText(String(b.title), 200)}”` : ''}: ${text(body)}`;
      }
      default: {
        const line = this.describeItem(root, se);
        return line ? `${from} this message: ${line}` : null;
      }
    }
  }

  /**
   * One conversation item as a line an agent can read, from the point of view of `se`; null to leave it out. Its
   * text is cut at n characters, saying so (#109).
   * @param {any} i @param {any} [se] @param {number} [n]
   */
  describeItem(i, se = null, n = READING.item) {
    const text = (s) => clipItem(s, n, i.id);
    switch (i.kind) {
      case 'user':
        return `You: ${text(i.text)}${i.attachments?.length ? ` [attached: ${i.attachments.map((a) => a.name ?? a.path).join(', ')}]` : ''}`;
      case 'agent':
        return i.text && i.status !== 'failed' ? `@${i.handle}: ${text(i.text)}` : null;
      case 'block': {
        if (!i.valid) return null;
        // What it holds comes with it, so another agent can review it (#153).
        const body = blockContent(i);
        const what = i.block.type === 'app' ? 'an app' : `a ${i.block.type} block`;
        const title = i.block.title ?? (i.block.type === 'app' ? i.block.fallback : null);
        return text(
          `@${i.handle} showed ${what}${title ? ` “${clipText(String(title), 200)}”` : ''}${body ? `${body.includes('\n') ? ':\n' : ': '}${body}` : ''}`,
        );
      }
      case 'voice': {
        // The agent hears about its own blocks as events already.
        const block = i.blockItemId && this.store.item(se?.threadId, i.blockItemId);
        if (block && block.sessionId === se?.id) return null;
        // An app’s summary is its own wording, never the person’s (#51).
        return `You: ${text(i.text)}${i.quote ? `\nThe app’s own summary, not the person’s words: “${text(i.quote)}”` : ''}`;
      }
      case 'shared':
        return `${i.summary ? 'Summary' : 'Shared'} from the thread “${i.fromTitle}”${i.agent ? `, by @${i.handle} in a turn the person started` : i.handle ? `, by @${i.handle}` : ', by the person'}: ${text(i.text)}`;
      case 'system':
        if (i.variant === 'wake') return `${i.from === 'you' ? 'You' : `@${i.from}`} woke @${i.to}`;
        if (i.variant === 'joined') return `@${i.to} joined`;
        if (i.variant === 'left') return `@${i.to} left`;
        if (i.variant === 'dataset') return `@${i.handle} loaded the dataset “${i.dataset}” (${i.records} records); search it by naming it in books`;
        return null;
      case 'sidelink':
        return `@${i.from} and @${i.to} talked in a side thread (${i.count ?? 0} messages${i.threadSummary ? `; in short, as a model summarized it: “${i.threadSummary}”` : ''}; read_conversation with thread: "${i.sideThreadId}" reads it)`;
      case 'command': {
        // A `!command` the person ran (#67), with its output, as Claude Code’s bash mode passes it on.
        const how =
          i.status === 'running'
            ? 'it’s still running'
            : i.status === 'stopped'
              ? 'they stopped it'
              : i.error
                ? `it couldn’t start: ${i.error}`
                : `it exited with ${i.exitCode ?? i.signal}`;
        const out = String(i.text ?? '');
        const tail = out.length > COMMAND_CONTEXT ? `…${out.slice(-COMMAND_CONTEXT)}` : out;
        return `You ran \`${clipText(String(i.command), 500)}\` in ${i.cwd} (${how}).${tail.trim() ? ` Output${i.cut || tail !== out ? ', the end of it' : ''}:\n\`\`\`\n${tail}\n\`\`\`` : ' No output.'}`;
      }
      case 'proposal':
        return `@${i.handle} proposed a new teammate, @${i.proposal?.handle}`;
      default:
        return null;
    }
  }

  /**
   * read_conversation: the conversation’s items, newest last, as text. thread: another thread of the same conversation
   * to read instead, such as a side thread or a topic thread (#121): its id from a catch-up line, a pointer to a fork, or
   * a link the person shared. Threads of other conversations are refused.
   */
  /** @param {any} se @param {{ limit?: number, skip?: number, thread?: unknown }} [args] */
  readConversation(se, { limit = 50, skip = 0, thread = null } = {}) {
    const id = typeof thread === 'string' && thread.trim() ? thread.trim().slice(0, 100) : se.threadId;
    if (!this.conversationThreads(se.threadId).includes(id))
      throw httpError(404, `There’s no thread ${id} in this conversation. Read one of its own threads: the id is in the catch-up line or the link.`);
    const items = this.store.items(id).filter((i) => i.kind !== 'system' || i.variant === 'wake');
    const n = Math.max(1, Math.min(200, Number(limit) || 50));
    const end = Math.max(0, items.length - Math.max(0, Number(skip) || 0));
    const slice = items.slice(Math.max(0, end - n), end);
    const lines = slice.map((i) => this.readLine(i, se)).filter(Boolean);
    const before = end - slice.length;
    return `${lines.join('\n\n') || 'The conversation is empty.'}${before ? `\n\n(${before} earlier ${before === 1 ? 'item' : 'items'}; call again with skip: ${items.length - before} to read them.)` : ''}`;
  }

  /**
   * An item as read_conversation and read_message give it to `se`, whose own messages say “You”.
   * @param {any} i @param {any} se @param {number} [n]
   */
  readLine(i, se, n = READING.item) {
    return i.sessionId === se.id && i.kind === 'agent' ? `You (@${se.handle}): ${clipItem(i.text, n, i.id)}` : this.describeItem(i, null, n);
  }

  /**
   * read_message: one item in full, by its id (the history and read_conversation give it where they cut one) or by
   * a block’s id, from any thread of this conversation: read_conversation { thread } reads its side and topic threads,
   * a fork’s among them (#110), so the ids it gives must work here too. Its own thread and the conversation it
   * branched from come first. Long text comes in parts (#109).
   * @param {any} se @param {{ id?: string, from?: number }} [args]
   */
  readMessage(se, { id, from = 0 } = {}) {
    const key = String(id ?? '').trim();
    if (!key) return { ok: false, message: 'Name the item: read_message { id }, with an id from your history or read_conversation.' };
    const threads = this.conversationThreads(se.threadId);
    let it = threads.map((th) => this.store.item(th, key)).find(Boolean);
    if (!it) {
      const blocks = threads.flatMap((th) => this.store.items(th).filter((i) => i.kind === 'block' && i.valid && i.block?.id === key));
      if (blocks.length > 1)
        return {
          ok: false,
          message: `More than one block is called “${key}”: ${blocks.map((b) => `@${b.handle}’s is ${b.id}`).join(', ')}. Read one by that id.`,
        };
      it = blocks[0];
    }
    if (!it)
      return {
        ok: false,
        message: `There’s no item “${clipText(key, 80)}” in this conversation. Your history and read_conversation give the id of each item they cut.`,
      };
    const full = this.readLine(it, se, Infinity);
    if (!full) return { ok: false, message: `${it.id} has nothing to read.` };
    const start = Math.max(0, Math.min(full.length, Math.floor(Number(from) || 0)));
    if (start >= full.length) return { ok: true, message: `Nothing after character ${count(full.length)}: that’s the end of ${it.id}.` };
    const end = Math.min(full.length, start + READING.part);
    if (start === 0 && end === full.length) return { ok: true, message: full };
    const more = end < full.length ? ` read_message { id: "${it.id}", from: ${end} } reads on.` : '';
    return { ok: true, message: `${full.slice(start, end)}\n\n(Characters ${count(start + 1)}–${count(end)} of ${count(full.length)}.${more})` };
  }

  // ── The lint pipeline ──────────────────────────────────────────────────────────────
  // Every check returns problems, { code, message, scope } (server/checks.mjs). The problems an agent turn caused
  // go back to the agent as one lint turn: the server’s checks run when the turn ends, and the browser reports what
  // it measures (diagrams, the app check) as the reply renders, so the lint turn waits a moment for those. There’s
  // at most one lint turn per agent turn, a lint turn is never linted, and problems from a turn that failed or was
  // stopped are dropped.

  /**
   * Every thread of a thread’s conversation: its lineage first, then the conversation’s other side and topic threads.
   * What read_conversation { thread } and read_message may read.
   * @param {string} threadId
   */
  conversationThreads(threadId) {
    const own = this.lineage(threadId);
    const root = own.at(-1);
    const rest = Object.values(this.s.threads)
      .filter((t) => !t.deleting && !own.includes(t.id) && this.lineage(t.id).at(-1) === root)
      .map((t) => t.id);
    return [...own, ...rest];
  }

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
    const problems = termProblems(turn.said, this.glossaryFor(turn.threadId), introducedTerms(items, apps), personSaid(items));
    // Diagrams too wide or too busy to read at the conversation’s width.
    const diagrams = lintDiagrams(turn.said);
    if (diagrams.length)
      this.rememberDiagrams(
        se.id,
        diagrams.map((d) => d.src),
      );
    problems.push(...diagramProblems(diagrams), ...rawHtmlProblems(turn.said));
    // A reply that should have been a block (#63): what this turn showed, and what the person last asked for.
    const own = this.store.items(turn.threadId);
    const shown = own.filter((it) => it.kind === 'block' && it.valid && it.turnId === turn.id).map((it) => it.block.type);
    problems.push(...blockProblems(turn.said, shown, own.findLast((it) => it.kind === 'user')?.text ?? ''));
    return problems;
  }

  /**
   * A turn that was stopped or failed starts no lint turn, but its progress steps still running show as stalled, as
   * at a normal end (#58), and the agent hears which at the start of its next turn (#98).
   * @param {any} turn @param {any} se @param {'stopped' | 'failed' | 'shutdown'} how
   */
  stallLeftRunning(turn, se, how) {
    const problems = this.stallSteps(turn, se);
    if (!problems.length) return;
    const blocks = problems.map((p) => `- Block “${p.scope.title ?? p.scope.id}” (id ${p.scope.id}): ${p.message}`);
    this.tellAgent(
      se.id,
      `${{ stopped: 'The person stopped your last turn', failed: 'Your last turn failed', shutdown: 'Postbox shut down during your last turn' }[how]} while progress steps were running:\n${blocks.join('\n')}`,
    );
  }

  /**
   * Progress steps still running when their agent’s turn ends are marked stalled, and the agent is told to close them.
   * Not the steps that were running when the person kept its background jobs running, while one runs on (#129): such
   * a step may follow the job, and they stall when the last one ends (endJob).
   * @param {{ threadId: string, keepJobs?: Set<string> }} turn
   */
  stallSteps(turn, se) {
    const problems = [];
    const runsOn = turn.keepJobs?.size || (se.jobs ?? []).some((j) => j.kept);
    const held = new Set(runsOn ? (se.heldSteps?.keys ?? []) : []);
    for (const it of this.store.items(turn.threadId)) {
      if (it.kind !== 'block' || !it.valid || it.sessionId !== se.id || it.block.type !== 'progress') continue;
      const stalls = (s) => s.state === 'running' && !held.has(`${it.id}:${s.id}`);
      const running = it.block.steps.filter(stalls);
      if (!running.length) continue;
      const steps = it.block.steps.map((s) => (stalls(s) ? { ...s, state: 'stalled' } : s));
      this.patchItem(turn.threadId, it.id, { block: { ...it.block, steps }, stalledAt: Date.now() });
      const names = running.map((s) => `“${s.label}”`);
      const one = running.length === 1;
      problems.push({
        code: 'steps-left-running',
        message: `${one ? 'Step' : 'Steps'} ${names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]} ${one ? 'was' : 'were'} still running when your turn ended, so the person sees ${one ? 'it' : 'them'} as stalled. Close each with update_block, as done or failed.`,
        scope: { kind: 'block', id: it.block.id, title: it.block.title },
      });
    }
    return problems;
  }

  lintEntry(sessionId, turnId) {
    let e = this.lints.get(turnId);
    if (!e) {
      e = { sessionId, kind: null, ended: false, sent: false, problems: [], timer: null, threadId: null };
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
    // The lint turn answers where the reply was.
    e.threadId = turn.threadId;
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
    const live = [...this.turns.values()].find((t) => t.id === turnId);
    // A turn that isn’t running and has no entry failed, was stopped, ran before a restart or is long gone: its
    // problems are dropped, so no lint turn lands about an old reply. A lint turn’s own problems are too.
    if ((!live && !this.lints.has(turnId)) || live?.kind === 'lint') return false;
    const e = this.lintEntry(sessionId, turnId);
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
      const checking = Object.values(this.s.apps).some((a) => a.sessionId === e.sessionId && a.check.status === 'pending' && !a.retired);
      if (wait > 0 && checking && Date.now() < until) {
        e.timer = setTimeout(send, wait);
        e.timer.unref?.();
        return;
      }
      e.sent = true;
      const se = this.s.sessions[e.sessionId];
      if (se && !se.deleting && !se.archived) this.deliver(e.sessionId, lintMessage(e.problems), { threadId: e.threadId });
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
    // What the browser reports later about this lint turn’s own work is never linted.
    Object.assign(this.lintEntry(se.id, turn.id), { kind: 'lint', ended: true, sent: true });
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
    // Only a diagram the reply has: its position and first lines come from the reply, not from the browser.
    const block = mermaidBlocks(String(it.text)).find((b) => b.src.trim() === src.trim());
    if (!block) return { ok: true, sent: false };
    const excerpt = block.src
      .split('\n')
      .slice(0, 3)
      .map((l) => clipText(l, 120))
      .join('\n');
    const scope = { kind: 'diagram', index: block.index, excerpt };
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

  requestPermission(sessionId, req) {
    return requestPermission(this, sessionId, req);
  }
  askPerson(sessionId, req) {
    return askPerson(this, sessionId, req);
  }
  alwaysFor(se, req) {
    return alwaysFor(this, se, req);
  }
  readsRules(backend) {
    return readsRules(this, backend);
  }
  settlePermission(itemId, status, message, answer, patch) {
    return settlePermission(this, itemId, status, message, answer, patch);
  }
  resolvePermission(threadId, itemId, action, values) {
    return resolvePermission(this, threadId, itemId, action, values);
  }
  allowAlways(threadId, it, asked) {
    return allowAlways(this, threadId, it, asked);
  }
  recordDenial(turn, d) {
    return recordDenial(this, turn, d);
  }
  resolveDenial(threadId, itemId, action) {
    return resolveDenial(this, threadId, itemId, action);
  }
  expireStalePermissions() {
    return expireStalePermissions(this);
  }

  // ── The permissions panel (#66) ────────────────────────────────────────────────────
  // For one agent in one conversation (or, from the persona editor, an agent on its own): its mode, its rules with
  // where each comes from, the folders it may work in, and what Postbox may change. Rules live where Claude Code
  // reads them, so a rule made here shows in the CLI’s /permissions, and the reverse; rules for this conversation
  // only live on the session and are passed with every turn.

  /**
   * Who the panel is about: { se, persona, project, folder }. A session’s persona is the one it runs with now.
   * @param {{ sessionId?: string|null, personaId?: string|null, projectId?: string|null }} who
   */
  async panelTarget({ sessionId = null, personaId = null, projectId = null }) {
    const se = sessionId ? this.session(sessionId) : null;
    const persona = se ? this.personaFor(se) : personaId ? this.persona(personaId) : null;
    if (!persona) throw httpError(404, 'That agent doesn’t exist.');
    const project = this.s.projects[se ? this.s.threads[se.threadId]?.projectId : (projectId ?? '')] ?? this.latestProject(persona.id) ?? null;
    const adapter = this.adapters.get(persona.backend);
    const folder = adapter?.folderFor ? await adapter.folderFor(persona, project) : persona.folder || project?.folder || null;
    return { se, persona, project, folder };
  }
  /** The project of a persona’s latest conversation, for the panel opened from the persona editor. */
  latestProject(personaId) {
    const recent = Object.values(this.s.sessions)
      .filter((x) => x.personaId === personaId)
      .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0];
    return recent ? this.s.projects[this.s.threads[recent.threadId]?.projectId] : null;
  }

  /**
   * Everything the panel shows. Rule lists carry their source: user, project, local (the settings files), conversation
   * (this session’s), tools (the persona’s unticked Tools, as deny rules), publishing (when it may not publish outside
   * Postbox), writes (ask rules for writes outside Postbox, #112) and postbox (its own tools, always allowed).
   * @param {{ sessionId?: string|null, personaId?: string|null, projectId?: string|null }} who
   */
  async permissionsView(who) {
    const { se, persona, project, folder } = await this.panelTarget(who);
    const real = persona.backend !== 'mock';
    // The mock shows its rules too (the Tools ones); a real backend that doesn’t read Claude Code’s shows none.
    const readsRules = !real || this.readsRules(persona.backend);
    const { usesHostSetup, canPublish } = setupOf(persona);
    const files = real && readsRules && folder ? await readRules({ folder, home: this.home, configDir: this.configDir, usesHostSetup }) : [];
    const has = new Set(persona.tools ?? []);
    const tools = Object.entries(TOOL_RULES).map(([id, rules]) => ({ id, on: has.has(id), rules }));
    const conversation = se ? { allow: [...(se.rules?.allow ?? [])], ask: [...(se.rules?.ask ?? [])], deny: [...(se.rules?.deny ?? [])] } : null;
    const running = Object.values(this.s.sessions).filter((x) => x.personaId === persona.id && this.turns.has(x.id));
    return {
      persona: {
        id: persona.id,
        handle: persona.handle,
        backend: persona.backend,
        permissionMode: persona.permissionMode ?? 'auto',
        usesHostSetup,
        canPublish,
      },
      sessionId: se?.id ?? null,
      projectId: project?.id ?? null,
      real,
      readsRules,
      folder,
      projectFolder: project?.folder ?? null,
      home: this.home,
      files,
      conversation,
      tools,
      publishing: canPublish ? [] : [...PUBLISHING_TOOLS],
      // Writes outside Postbox ask first (#112), except what the persona may publish, for a backend that reads rules.
      writes: { rules: real && readsRules ? writeRules(persona) : [], unless: canPublish ? [...PUBLISHING_TOOLS] : [] },
      folders: [
        ...(folder ? [{ path: folder, source: 'folder' }] : []),
        ...(project?.folder && project.folder !== folder ? [{ path: project.folder, source: 'project' }] : []),
        ...(se?.addDirs ?? []).map((path) => ({ path, source: 'conversation' })),
        ...files.flatMap((f) => f.dirs.map((path) => ({ path, source: f.source }))),
      ],
      // Agents of this persona with a turn running now: a mode change reaches them now only where the backend allows.
      running: running.map((x) => x.handle),
    };
  }

  /**
   * Adds or removes a rule. where: local (the default, as the CLI saves “don’t ask again”), user (the person’s own
   * settings, only for a persona that loads them) or conversation (this session only). The project’s shared
   * settings.json is never written.
   * @param {{ sessionId?: string|null, personaId?: string|null, projectId?: string|null, behavior: string, rule: string,
   *           where?: string, remove?: boolean }} change
   */
  async changePermissionRule({ sessionId = null, personaId = null, projectId = null, behavior, rule, where = 'local', remove = false }) {
    if (!BEHAVIORS.includes(/** @type {any} */ (behavior))) throw httpError(422, 'A rule allows, asks or denies.');
    const clean = cleanRule(rule);
    if (!clean)
      throw httpError(
        422,
        'That isn’t a rule. Write a tool name, and what it covers in parentheses: Bash(npm test:*), WebFetch(domain:example.com), Read(./src/**).',
      );
    if (where === 'project')
      throw httpError(
        409,
        'The project’s settings are shared with your team, so Postbox doesn’t change them. Save the rule in this folder’s local settings, or edit .claude/settings.json yourself.',
      );
    if (!['local', 'user', 'conversation'].includes(where))
      throw httpError(422, 'A rule is saved in this folder’s local settings, your user settings or this conversation.');
    const { se, persona, folder } = await this.panelTarget({ sessionId, personaId, projectId });
    if (persona.backend === 'mock' || !this.readsRules(persona.backend)) throw httpError(409, 'Only Claude Code and Agent SDK agents read permission rules.');
    const b = /** @type {'allow'|'ask'|'deny'} */ (behavior);
    if (where === 'conversation') {
      if (!se) throw httpError(409, 'Open the panel from a conversation to make a rule for it only.');
      const rules = { allow: [...(se.rules?.allow ?? [])], ask: [...(se.rules?.ask ?? [])], deny: [...(se.rules?.deny ?? [])] };
      if (remove) rules[b] = rules[b].filter((r) => r !== clean);
      else if (!rules[b].includes(clean)) {
        if (rules[b].length >= MAX_CONVERSATION_RULES) throw httpError(422, `A conversation keeps up to ${MAX_CONVERSATION_RULES} ${b} rules.`);
        rules[b].push(clean);
      }
      this.updateSession(se.id, { rules });
      return { ok: true, where, applies: 'next turn' };
    }
    if (where === 'user' && !setupOf(persona).usesHostSetup)
      throw httpError(
        409,
        `@${persona.handle} is isolated, so it doesn’t read your user settings. Save the rule in this folder’s local settings, or this conversation.`,
      );
    if (!folder) throw httpError(409, `@${persona.handle} has no folder yet, so there’s no local settings file to save in.`);
    const files = settingsFiles(folder, this.home, this.configDir);
    const { file, changed } = await changeRule(files[/** @type {'local'|'user'} */ (where)], { behavior: b, rule: clean, remove });
    return { ok: true, where, file, changed, applies: 'next turn' };
  }

  /**
   * Adds a folder this conversation’s agent may work in, passed as --add-dir / additionalDirectories from its next
   * turn, or removes one. path is absolute, or relative to the project’s folder (from the folder picker).
   * @param {{ sessionId: string, path: string, remove?: boolean }} change
   */
  async changePermissionFolder({ sessionId, path, remove = false }) {
    const se = this.session(sessionId);
    const project = this.s.projects[this.s.threads[se.threadId]?.projectId];
    const raw = String(path ?? '').trim();
    if (!raw || raw.length > 1000) throw httpError(422, 'Pick a folder, or write its full path.');
    const dir = isAbsolute(raw) ? resolve(raw) : project?.folder ? resolve(project.folder, raw) : null;
    if (!dir) throw httpError(422, 'Write the folder’s full path.');
    const dirs = [...(se.addDirs ?? [])];
    if (remove) {
      this.updateSession(se.id, { addDirs: dirs.filter((d) => d !== dir) });
      return { ok: true, path: dir };
    }
    const st = await stat(dir).catch(() => null);
    if (!st?.isDirectory()) throw httpError(422, `${dir} isn’t a folder on this computer.`);
    if (!dirs.includes(dir)) {
      if (dirs.length >= MAX_ADD_DIRS) throw httpError(422, `A conversation can add up to ${MAX_ADD_DIRS} folders.`);
      this.updateSession(se.id, { addDirs: [...dirs, dir] });
    }
    return { ok: true, path: dir, applies: 'next turn' };
  }

  /**
   * Sets a persona’s permission mode (intent.md: it reaches running conversations from their next turn). Where the
   * backend can change a running turn (the Agent SDK’s setPermissionMode), its running turns change now too.
   * @param {string} personaId @param {string} mode
   * @returns {Promise<{ ok: true, now: string[] }>}  now: the handles whose running turn changed at once
   */
  async setPermissionMode(personaId, mode) {
    const p = this.persona(personaId);
    if (!p) throw httpError(404, 'That agent doesn’t exist.');
    if (!PERMISSION_MODES.includes(mode)) throw httpError(422, `Permissions are one of ${PERMISSION_MODES.join(', ')}.`);
    if ((p.permissionMode ?? 'auto') !== mode) this.updatePersona(personaId, { permissionMode: mode });
    const now = [];
    for (const se of Object.values(this.s.sessions)) {
      const turn = se.personaId === personaId ? this.turns.get(se.id) : null;
      if (turn?.control?.setPermissionMode && (await turn.control.setPermissionMode(mode))) now.push(se.handle);
    }
    return { ok: true, now };
  }

  // ── Commands in the composer (#67) ─────────────────────────────────────────────────
  // `/` runs Postbox’s own commands without a turn, or an agent’s skill or command as its turn; `!` runs a command line
  // as the person, in the conversation’s folder, and the agents read it on their next turn, without being woken.

  /**
   * Keeps an agent’s skills and commands on its session, bounded, for the / menu: from init (names; terminal-only
   * ones are already left out) or the SDK’s supportedCommands() (with descriptions and argument hints).
   * @param {string} sessionId @param {unknown} list
   */
  recordCommands(sessionId, list) {
    if (!this.s.sessions[sessionId] || !Array.isArray(list)) return;
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
    this.updateSession(sessionId, { commands: { at: Date.now(), list: commands } });
  }

  /**
   * Runs an agent’s skill or command as its turn: `/name args` is the whole prompt (deliver skips the catch-up, which
   * waits for the next turn), posted in the conversation as you wrote it. In a room, it addresses that agent.
   * @param {string} threadId @param {{ sessionId: string, text: string }} req
   */
  runAgentCommand(threadId, { sessionId, text }) {
    const t = this.thread(threadId);
    if (t.deleting) throw httpError(409, 'This conversation is being deleted. Undo it first.');
    const line = String(text ?? '')
      .trim()
      .slice(0, 50000);
    if (!/^\/[\w:.@/-]+/.test(line)) throw httpError(422, 'A skill or command starts with / and its name, such as /review.');
    const se = this.sessionsIn(threadId).find((x) => x.id === sessionId);
    if (!se) throw httpError(404, 'That agent isn’t in this conversation.');
    if (se.archived) throw httpError(409, `@${se.handle}’s session is archived. Restore it first.`);
    if (this.turns.has(se.id)) throw httpError(409, `@${se.handle} is busy. Stop it, or wait for it to finish, then run the command.`);
    const item = this.addItem(threadId, { kind: 'user', text: line, attachments: [], command: { sessionId: se.id, handle: se.handle } });
    this.putThread({ ...this.s.threads[threadId], hops: 0 });
    if (this.sessionsIn(threadId).length > 1) this.addItem(threadId, { kind: 'system', variant: 'wake', from: 'you', to: se.handle });
    this.deliver(se.id, { kind: 'user', text: line, attachments: [], itemId: item.id, slash: true });
    return { item };
  }

  /**
   * Changes the model or the effort a conversation runs with (/model, /effort). Both are fixed in the session’s
   * snapshot, so this changes the snapshot: from the next turn, and now too where the backend can change a running
   * turn (the Agent SDK’s setModel and its effort setting, tried and reported).
   * @param {string} sessionId @param {{ model?: string, effort?: string }} change
   * @returns {Promise<{ ok: true, now: boolean }>}
   */
  async setSessionRun(sessionId, { model, effort }) {
    const se = this.session(sessionId);
    if (this.persona(se.personaId)?.backend === 'mock') throw httpError(409, 'A mock agent has no model or effort to change.');
    /** @type {Record<string, string>} */
    const patch = {};
    if (model !== undefined) {
      const m = String(model).trim();
      if (!m || m.length > 100 || !/^[\w.:[\]-]+$/.test(m)) throw httpError(422, 'A model is a name such as claude-opus-5-5.');
      patch.model = m;
    }
    if (effort !== undefined) {
      checkEffort(effort);
      patch.effort = String(effort);
    }
    if (!Object.keys(patch).length) throw httpError(422, 'Say which model or effort to use.');
    this.updateSession(se.id, { personaSnapshot: { ...(se.personaSnapshot ?? {}), ...patch } });
    const control = this.turns.get(se.id)?.control;
    let now = false;
    if (control) {
      const results = await Promise.all([
        patch.model && control.setModel ? control.setModel(patch.model) : null,
        patch.effort && control.setEffort ? control.setEffort(patch.effort) : null,
      ]);
      now = results.filter((r) => r !== null).length > 0 && results.every((r) => r !== false);
    }
    return { ok: true, now };
  }

  /**
   * The folder a conversation’s `!` commands run in: where the agent that replies there works, as its adapter decides
   * (its own folder, the project’s, or a workspace of its own), else the project’s.
   */
  async commandFolder(threadId) {
    const t = this.thread(threadId);
    const members = this.sessionsIn(threadId).filter((x) => !x.archived);
    const se = members.find((x) => x.id === t.lastSpeaker) ?? members[0];
    const persona = se ? this.personaFor(se) : null;
    const project = this.s.projects[t.projectId] ?? null;
    const adapter = persona ? this.adapters.get(persona.backend) : null;
    if (adapter?.folderFor) return adapter.folderFor(persona, project);
    return persona?.folder || project?.folder || null;
  }

  /**
   * Runs `!command` (#67) as the person, in the conversation’s folder. Output streams into a command item; the item
   * ends with the exit code and the duration. The agents read it with what they missed, at the start of their next
   * turn. What the store keeps is bounded: the item holds the last MAX_COMMAND_OUTPUT characters (it says when
   * earlier output was cut), and once output passes that, the item is refreshed with its end at most every
   * COMMAND_REFRESH_MS, and at most MAX_COMMAND_REFRESHES times, then once more when the command ends.
   * @param {string} threadId @param {string} command
   */
  async runShellCommand(threadId, command) {
    const t = this.thread(threadId);
    if (t.deleting) throw httpError(409, 'This conversation is being deleted. Undo it first.');
    const line = String(command ?? '').trim();
    if (!line) throw httpError(422, 'Write a command after the !.');
    if (line.length > 10000) throw httpError(422, 'A command is limited to 10,000 characters.');
    const cwd = await this.commandFolder(threadId);
    if (!cwd) throw httpError(409, 'This conversation has no folder to run commands in. Give the project or the agent a folder first.');
    const startedAt = Date.now();
    const it = this.addItem(threadId, {
      kind: 'command',
      command: line,
      cwd,
      status: 'running',
      text: '',
      cut: false,
      exitCode: null,
      signal: null,
      startedAt,
    });
    let out = ''; // the end of the output so far, at most twice the bound between flushes
    let sent = 0; // characters already sent as item.text, before the output was cut
    let cut = false;
    let refreshed = 0; // refreshes of the item’s text since it was cut
    let refreshedAt = 0;
    /** @type {NodeJS.Timeout|null} */
    let timer = null;
    const flush = ({ final = false } = {}) => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (!this.store.item(threadId, it.id)) return;
      if (!cut && out.length <= MAX_COMMAND_OUTPUT) {
        // Only the new text, as the reply of an agent streams.
        if (out.length > sent) this.store.emit('item.text', { threadId, id: it.id, text: out.slice(sent) });
        sent = out.length;
        return;
      }
      cut = true;
      out = out.slice(-MAX_COMMAND_OUTPUT);
      // Past the bound, each refresh replaces the whole text, so they’re rare and few; the end always arrives.
      const now = Date.now();
      if (!final && (refreshed >= MAX_COMMAND_REFRESHES || now - refreshedAt < COMMAND_REFRESH_MS)) return;
      refreshed++;
      refreshedAt = now;
      this.patchItem(threadId, it.id, { text: out, cut: true, ...(refreshed >= MAX_COMMAND_REFRESHES && !final ? { paused: true } : {}) });
    };
    const run = { stopped: false, stop: () => false, kill: () => false, done: Promise.resolve(), flush };
    this.shellRuns.set(it.id, run);
    const handle = runShell({
      command: line,
      cwd,
      ...(this.spawnShell ? { spawnImpl: this.spawnShell } : {}),
      onOutput: (text) => {
        out += text;
        if (out.length > 2 * MAX_COMMAND_OUTPUT) {
          out = out.slice(-MAX_COMMAND_OUTPUT);
          cut = true;
        }
        if (!timer) {
          timer = setTimeout(flush, COMMAND_FLUSH_MS);
          timer.unref?.();
        }
      },
      onExit: ({ code = null, signal = null, error }) => {
        flush({ final: true });
        this.shellRuns.delete(it.id);
        if (!this.store.item(threadId, it.id)) return;
        this.patchItem(threadId, it.id, {
          status: run.stopped ? 'stopped' : error ? 'failed' : code === 0 ? 'done' : 'failed',
          exitCode: typeof code === 'number' ? code : null,
          signal: signal ?? null,
          ms: Date.now() - startedAt,
          ...(cut ? { paused: false } : {}),
          ...(run.closing ? { error: 'Postbox stopped it as it shut down.' } : error ? { error: clipText(String(error.message ?? error), 300) } : {}),
        });
      },
    });
    Object.assign(run, { stop: handle.stop, kill: handle.kill, done: handle.done });
    return { item: it };
  }

  /** Sends the output of running commands that’s waiting for its next flush now (tests await this, not a timer). */
  flushShellOutput() {
    for (const run of this.shellRuns.values()) run.flush();
  }

  /** Stop on a running `!command`: SIGINT, then SIGKILL. */
  stopShellCommand(threadId, itemId) {
    const it = this.store.item(threadId, itemId);
    const run = this.shellRuns.get(itemId);
    if (it?.kind !== 'command' || !run) throw httpError(409, 'That command already finished.');
    run.stopped = true;
    run.stop();
    return { ok: true };
  }

  /**
   * When Postbox shuts down: every running command, in its own process group, would outlive it. Each gets SIGINT,
   * and SIGKILL if it hasn’t ended within graceMs.
   * @param {{ graceMs?: number }} [opts]
   */
  async stopShellCommands({ graceMs = 2000 } = {}) {
    const runs = [...this.shellRuns.values()];
    if (!runs.length) return;
    for (const run of runs) {
      run.stopped = true;
      run.closing = true;
      run.stop();
    }
    /** @type {NodeJS.Timeout|undefined} */
    let timer;
    const late = new Promise((r) => {
      timer = setTimeout(r, graceMs);
    });
    await Promise.race([Promise.all(runs.map((r) => r.done)), late]);
    clearTimeout(timer);
    for (const run of runs) run.kill();
  }

  /**
   * After a restart, nothing Postbox started is running any more, unless Postbox stopped without shutting down (a crash),
   * which can leave a command running on its own. Either way its output here ends.
   */
  // ── The work ledger (#132) ─────────────────────────────────────────────────────────
  // What a conversation’s agents changed, ran and published, read by the Work view. A conversation is the one a
  // thread belongs to: its side and topic threads count toward it.

  workConversation(threadId) {
    const t = this.thread(threadId);
    if (t.kind === 'side' || t.kind === 'topic') throw httpError(404, 'Open the conversation this thread belongs to: its work is there.');
    return t.id;
  }
  /** Where each changed file and commit stands in git now (read-only). */
  workGit(threadId) {
    return this.ledger.gitState(this.workConversation(threadId));
  }
  /** @param {string} threadId @param {string} fileId @param {string|null} [changeId] */
  workDiff(threadId, fileId, changeId = null) {
    return this.ledger.fileDiff(this.workConversation(threadId), fileId, changeId).catch(asHttp);
  }
  workOutput(threadId, entryId) {
    return this.ledger.output(this.workConversation(threadId), entryId).catch(asHttp);
  }
  /**
   * Puts a file back as it was before the agents first changed it (or removes one they created), and says so in the
   * conversation, so its agents read it on their next turn.
   */
  async restoreWork(threadId, fileId) {
    const convId = this.workConversation(threadId);
    const f = await this.ledger.restore(convId, fileId).catch(asHttp);
    const who = f?.handles?.length ? f.handles.map((h) => `@${h}`).join(', ') : 'the agents';
    this.addItem(convId, {
      kind: 'voice',
      text: f?.before?.exists ? `Restored ${f.rel} to how it was before ${who} changed it` : `Removed ${f?.rel}, which ${who} created`,
    });
    return f;
  }

  expireStaleCommands() {
    for (const [threadId, items] of Object.entries(this.s.items))
      for (const it of items)
        if (it.kind === 'command' && it.status === 'running')
          this.patchItem(threadId, it.id, {
            status: 'stopped',
            error: 'Postbox restarted while it ran. If Postbox didn’t shut down cleanly, it may still be running.',
          });
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
    effort = DEFAULT_EFFORT,
    permissionMode = 'auto',
    usesHostSetup = true,
    canPublish = false,
    mcpOff = [],
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
    checkEffort(effort);
    checkSetup({ usesHostSetup, canPublish, mcpOff });
    const p = {
      id: newId('pe'),
      handle,
      description,
      instructions,
      model: String(model || DEFAULT_MODEL),
      effort,
      backend,
      permissionMode,
      usesHostSetup,
      canPublish,
      mcpOff: serverNames(mcpOff),
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
    if (patch.effort !== undefined) checkEffort(patch.effort);
    checkSetup(patch);
    if (patch.mcpOff !== undefined) patch = { ...patch, mcpOff: serverNames(patch.mcpOff) };
    if (patch.backend !== undefined && !this.adapters.names().includes(patch.backend))
      throw httpError(422, `“${patch.backend}” isn’t available on this computer. Available: ${this.adapters.names().join(', ')}.`);
    // A persona moved from the mock to a real model gets the default model.
    if (patch.backend && patch.backend !== 'mock' && (patch.model ?? p.model) === 'mock') patch = { ...patch, model: DEFAULT_MODEL };
    const next = {
      ...p,
      ...pick(patch, [
        'description',
        'instructions',
        'backend',
        'model',
        'effort',
        'permissionMode',
        'usesHostSetup',
        'canPublish',
        'mcpOff',
        'folder',
        'tools',
        'examples',
        'retired',
      ]),
      version: (p.version ?? 1) + 1,
    };
    this.store.emit('persona', next);
    // A card that asked for a tool now on answers itself, wherever it was turned on (#237).
    if (patch.tools !== undefined) settleToolAsks(this, next);
    return next;
  }

  /**
   * What the persona sheet’s MCP list needs (#59), given a persona (or none, for a new agent) and a project: the
   * folder it works in (its own, else the project’s, else that of its latest conversation), and the MCP servers the
   * latest init reported. That init comes from one of its sessions, else from any session of a persona that loads
   * your setup, since claude.ai connectors and plugin servers are the same for all of them.
   * @param {string|null} personaId @param {string|null} projectId
   */
  mcpContext(personaId, projectId) {
    const persona = (personaId && this.persona(personaId)) || null;
    const latest = (list) => list.filter((se) => se.mcpServers?.at).sort((x, y) => y.mcpServers.at - x.mcpServers.at)[0] ?? null;
    const own = persona ? Object.values(this.s.sessions).filter((se) => se.personaId === persona.id) : [];
    const recent = own.sort((x, y) => (y.startedAt ?? 0) - (x.startedAt ?? 0))[0];
    const project = (projectId && this.s.projects[projectId]) || this.s.projects[this.s.threads[recent?.threadId]?.projectId] || null;
    const seen =
      latest(own) ?? latest(Object.values(this.s.sessions).filter((se) => this.persona(se.personaId)?.usesHostSetup !== false && se.backend !== 'mock'));
    const folder = persona?.folder || project?.folder || null;
    // An init from another folder says nothing about that folder’s project and local servers here: keep only the
    // ones that load everywhere (user, claude.ai, plugins).
    const seenFolder = seen && (this.persona(seen.personaId)?.folder || this.s.projects[this.s.threads[seen.threadId]?.projectId]?.folder || null);
    const servers = seen?.mcpServers.servers ?? [];
    return {
      persona,
      folder,
      seen: seenFolder === folder ? servers : servers.filter((s) => s.source !== 'project' && s.source !== 'local'),
    };
  }

  // ── Session lifecycle: archive, restore, delete with undo ─────────────────────────

  archive(sessionId) {
    this.stop(sessionId, { silent: true });
    const se = this.session(sessionId);
    this.updateSession(sessionId, { archived: true, state: 'idle', needs: null, archivedAt: Date.now() });
    dropWakes(this, se, 'archived');
    const t = this.s.threads[se.threadId];
    if (t && this.sessionsIn(t.id).every((x) => x.id === sessionId || x.archived)) this.putThread({ ...t, archived: true });
  }

  restore(sessionId) {
    const se = this.session(sessionId);
    if (se.retiredFork) throw httpError(409, 'A fork from before agents had one session per conversation can’t come back: its agent answers there now.');
    this.updateSession(sessionId, { archived: false, archivedAt: null });
    const t = this.s.threads[se.threadId];
    if (t?.archived) this.putThread({ ...t, archived: false });
  }

  /**
   * A conversation or room and every thread under it, a side thread a topic thread’s fork woke included: what
   * archiving or restoring it covers (#101).
   */
  archiveScope(threadId) {
    const t = this.thread(threadId);
    if (t.kind === 'topic' || t.kind === 'side') throw httpError(409, 'Archive the conversation it belongs to instead.');
    return [t, ...Object.values(this.s.threads).filter((x) => x.id !== t.id && this.lineage(x.id).at(-1) === t.id)];
  }

  /**
   * Archives a conversation (#101): every session in it, its side and topic threads’ forks too, through archive(),
   * so each keeps its transcript and its backend session for Restore. It leaves the overview and the rail.
   */
  archiveThread(threadId) {
    const threads = this.archiveScope(threadId);
    const ids = threads
      .flatMap((t) => this.sessionsIn(t.id))
      .filter((se) => !se.archived)
      .map((se) => se.id);
    for (const id of ids) this.archive(id);
    for (const t of threads) if (!this.s.threads[t.id].archived) this.putThread({ ...this.s.threads[t.id], archived: true });
    // What it archived, so Restore in its toast brings back only these, not an agent archived on its own before.
    return ids;
  }

  /** Restores every archived session in a conversation and its side and topic threads, and the threads with them. */
  restoreThread(threadId) {
    const threads = this.archiveScope(threadId);
    // A fork retired by #228’s migration stays archived.
    for (const t of threads) for (const se of this.sessionsIn(t.id)) if (se.archived && !se.retiredFork) this.restore(se.id);
    for (const t of threads) if (this.s.threads[t.id].archived) this.putThread({ ...this.s.threads[t.id], archived: false });
  }

  /**
   * Archives each conversation where nothing has happened for the days Settings says (#101): no message, no turn,
   * nothing waiting on you (a question, an unread reply, a queued message), nothing working, no background job
   * running and no wake scheduled, in it or the threads under it. The server runs it at startup and every hour. It
   * only archives: deleting stays the person’s action.
   * @param {number} [now]
   * @returns {string[]} the conversations it archived
   */
  archiveIdle(now = Date.now()) {
    const days = this.s.settings.archiveAfterDays ?? ARCHIVE_AFTER_DAYS;
    if (!days) return [];
    const done = [];
    for (const t of Object.values(this.s.threads)) {
      if (t.kind === 'topic' || t.kind === 'side' || t.archived || t.deleting) continue;
      const threads = this.archiveScope(t.id);
      const ses = threads.flatMap((x) => this.sessionsIn(x.id)).filter((se) => !se.archived);
      const waiting = (se) =>
        se.needs ||
        se.unread ||
        ['think', 'gen', 'tool', 'stopping'].includes(se.state) ||
        this.turns.has(se.id) ||
        // A background job still running (#129), or a wake an agent scheduled, is something happening too.
        (se.jobs ?? []).some((j) => j.state === 'running') ||
        Object.values(this.s.schedules).some((sc) => sc.sessionId === se.id);
      if (!ses.length || ses.some(waiting) || threads.some((x) => x.queue?.length)) continue;
      const last = Math.max(
        t.createdAt ?? 0,
        ...ses.map((se) => Math.max(se.updatedAt ?? 0, se.finishedAt ?? 0, se.startedAt ?? 0)),
        ...threads.map((x) => this.store.items(x.id).at(-1)?.at ?? 0),
      );
      if (now - last < days * 864e5) continue;
      this.archiveThread(t.id);
      done.push(t.id);
    }
    return done;
  }

  /** Deletes after DELETE_UNDO_MS unless undone. The persona always stays. */
  deleteSession(sessionId) {
    this.stop(sessionId, { silent: true });
    const se = this.session(sessionId);
    const until = Date.now() + DELETE_UNDO_MS;
    this.updateSession(sessionId, { deleting: until });
    dropWakes(this, se, 'removed');
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
    // Background jobs Postbox kept running for them would run on with no record (#129).
    this.stopKeptJobs(
      ids.flatMap((id) => this.s.threads[id]?.members ?? []),
      'Its conversation was deleted.',
    );
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
    // Background jobs Postbox kept running for it would run on with no record (#129).
    this.stopKeptJobs([sessionId], 'Its session was deleted.');
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
          // An archived agent isn’t woken: deliver() would refuse it, here outside any request (#101).
          if (!this.s.sessions[sc.sessionId] || this.s.sessions[sc.sessionId].archived) return;
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

  // ── Apps (server/apps.mjs) ─────────────────────────────────────────────────────────

  static APP_SEND_LIMIT = APP_SEND_LIMIT;
  static APP_SEND_WINDOW_MS = APP_SEND_WINDOW_MS;
  static APP_HOLD_MAX = APP_HOLD_MAX;
  appCheck(appId, report) {
    return appCheck(this, appId, report);
  }
  appEvent(appId, action, values, opts) {
    return appEvent(this, appId, action, values, opts);
  }
  needAppSend(app, itemId, waiting) {
    return needAppSend(this, app, itemId, waiting);
  }
  resolveAppSend(threadId, itemId, action, opts) {
    return resolveAppSend(this, threadId, itemId, action, opts);
  }
  appState(appId, state) {
    return appState(this, appId, state);
  }
  appQuery(appId, tool, args) {
    return appQuery(this, appId, tool, args);
  }
  appFile(appId, name, v) {
    return appFile(this, appId, name, v);
  }
  agentFolders(sessionId) {
    return agentFolders(this, sessionId);
  }
  agentFile(sessionId, path, max, what) {
    return agentFile(this, sessionId, path, max, what);
  }
  appFiles(sessionId, args) {
    return appFiles(this, sessionId, args);
  }
  registerApp(sessionId, block, itemId, threadId, files) {
    return registerApp(this, sessionId, block, itemId, threadId, files);
  }

  // ── Datasets (#47) ─────────────────────────────────────────────────────────────────

  /**
   * add_dataset: loads a JSON Lines file from the project’s own Postbox folder, .postbox/datasets/, into the corpus,
   * without a restart, which would end every agent’s session. Its records are searched only when a search names the
   * dataset, so they don’t mix into other agents’ results. An event keeps it, so it’s loaded again after a restart,
   * and a line in the conversation says it was loaded. Loading the same id again replaces it.
   * @param {string} sessionId @param {{ id?: unknown, path?: unknown, title?: unknown }} args
   */
  async addDataset(sessionId, { id, path, title } = {}) {
    const se = this.session(sessionId);
    const project = this.s.projects[this.s.threads[se.threadId]?.projectId];
    const name = String(id ?? '');
    if (!DATASET_ID.test(name)) return { ok: false, message: 'A dataset id is letters, digits, - and _ (up to 64), such as “scifact-abstracts”.' };
    const taken = this.corpus.stats().books.find((b) => b.id === name);
    if (taken && !taken.dataset) return { ok: false, message: `“${name}” is a book in the corpus. Pick another id.` };
    if (!project?.folder)
      return {
        ok: false,
        message: 'This conversation’s project has no folder, so there’s no .postbox/datasets/ to load from. Ask the person to give the project a folder.',
      };
    const dir = datasetDir(project.folder);
    let raw;
    try {
      raw = await this.datasetFile(dir, path);
    } catch (e) {
      return { ok: false, message: e.message };
    }
    let records;
    try {
      records = parseDataset(raw.text);
    } catch (e) {
      return { ok: false, message: e.message };
    }
    const meta = { title: clip(String(title ?? '') || name, 200), author: `@${se.handle}` };
    this.corpus.addRecords(name, records, meta);
    this.corpus.reindex();
    this.store.emit('dataset', { id: name, projectId: project.id, path: raw.path, ...meta, records: records.length, by: se.handle, at: Date.now() });
    this.addItem(se.threadId, { kind: 'system', variant: 'dataset', handle: se.handle, dataset: name, records: records.length });
    return {
      ok: true,
      message: `Loaded ${records.length.toLocaleString('en-US')} records as the dataset “${name}”. It’s searched only when a search names it: corpus.search with books: ["${name}"]. corpus.read with id "${name}:<record id>" reads one record.`,
    };
  }

  /**
   * Reads a dataset file: a path in the project’s .postbox/datasets/ (relative to it), followed through links, so a
   * link can’t lead outside it, and up to datasetBytes.
   * @param {string} dir @param {unknown} path
   */
  async datasetFile(dir, path) {
    if (typeof path !== 'string' || !path.trim()) throw new Error(`add_dataset needs the path of a .jsonl file in ${dir}.`);
    const root = await realpath(dir).catch(() => null);
    if (!root) throw new Error(`There’s no folder ${dir} yet. Write the dataset there, then load it.`);
    const real = await realpath(resolve(root, path)).catch(() => null);
    if (!real) throw new Error(`There’s no file at ${path} in ${dir}.`);
    if (!real.startsWith(root + sep)) throw new Error(`${path} is outside ${dir}. Datasets load only from there.`);
    const st = await stat(real);
    if (!st.isFile()) throw new Error(`${path} isn’t a file.`);
    const over = () => new Error(`${path} is over ${limitText('datasetBytes')}, the limit for a dataset.`);
    if (st.size > LIMITS.datasetBytes) throw over();
    const buf = await readCapped(real, LIMITS.datasetBytes);
    if (!buf) throw over();
    return { path: relative(root, real), text: buf.toString('utf8') };
  }

  /** At startup: loads the datasets agents added before the restart, from where they were. Returns how many loaded. */
  async reloadDatasets() {
    let n = 0;
    for (const ds of Object.values(this.s.datasets ?? {})) {
      const folder = this.s.projects[ds.projectId]?.folder;
      try {
        if (!folder) throw new Error('its project has no folder now');
        const { text } = await this.datasetFile(datasetDir(folder), ds.path);
        this.corpus.addRecords(ds.id, parseDataset(text), { title: ds.title, author: ds.author });
        n++;
      } catch (e) {
        console.warn(`Couldn’t load the dataset “${ds.id}” again: ${e.message}`);
      }
    }
    if (n) this.corpus.reindex();
    return n;
  }

  // ── Presence ───────────────────────────────────────────────────────────────────────

  view(threadId) {
    if (!threadId) return;
    this.viewing.set(threadId, Date.now());
    for (const se of this.sessionsIn(threadId)) if (se.unread) this.updateSession(se.id, { unread: 0 });
    if (this.s.threads[threadId]?.unread) this.putThread({ ...this.s.threads[threadId], unread: 0 });
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
    // Where the turn speaks: its session’s thread, or the side thread it answers in (#110).
    const threadId = () => turn?.threadId ?? se().threadId;
    return {
      /** @param {{ block: any }} args @param {{ files?: AppFile[] }} [given]  data files Postbox read for show_app (#54) */
      show_block({ block }, given = {}) {
        // An outcome reports what came of an answer (#94). On a new block it would show under whatever the person
        // answers, even Cancel, so it’s refused here and only taken by update_block once the block is answered.
        if (block && typeof block === 'object' && Object.hasOwn(block, 'outcome'))
          return { ok: false, message: OUTCOME_LATER(String(block.id ?? 'this block'), 'The block wasn’t shown.') };
        const v = validateBlock(block, { imageOrigins: rt.config.imageOrigins });
        // App ids are global. Yours already: it’s a new version. Another agent’s: yours gets a fresh id, and
        // theirs (its versions and saved state) is left alone.
        /** @type {string | null} */
        let renamed = null;
        if (v.ok && v.block.type === 'app' && rt.s.apps[v.block.id]) {
          const { id, code, permissions, title } = /** @type {any} */ (v.block);
          if (rt.s.apps[id].sessionId === sessionId) return this.update_app({ id, code, permissions, title }, given);
          renamed = newId(String(id).slice(0, 40));
          v.block = { ...v.block, id: renamed };
        }
        // Any other id names one block of this session in this conversation, answered or not, so an answer to it,
        // and an update or outcome by it, always means that block (#125). Showing it again is refused, not turned
        // into an update: an update can reopen a block the person answered.
        if (v.ok && v.block.type !== 'app') {
          const id = v.block.id;
          const shown = rt.store.items(threadId()).find((x) => x.kind === 'block' && x.valid && x.sessionId === sessionId && x.block.id === id);
          // An app’s id can’t take a block’s update, so that case only asks for a new id.
          if (shown?.block.type === 'app')
            return { ok: false, message: `${id} is the id of your app “${shown.block.title ?? id}”. Pick a new id for this block.` };
          if (shown) return { ok: false, message: `Block ${id} is already shown. Use update_block to change it, or pick a new id.` };
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
        if (v.ok && v.block.type === 'app') rt.registerApp(sessionId, v.block, it.id, threadId(), given.files ?? []);
        return v.ok
          ? { ok: true, message: renamed ? `That app id was taken, so it’s shown as ${renamed}. Use that id to update it.` : `Shown block ${v.block.id}.` }
          : { ok: false, message: `The block was invalid, so the person sees its fallback text. Problems: ${v.errors.join(' ')}` };
      },
      update_block(args) {
        return updateBlock(rt, sessionId, args, { turn, se, threadId, endSegment });
      },
      review_block: (args) => reviewBlock(rt, sessionId, args),
      /**
       * @param {{ id?: string, title?: string, code: string, permissions?: string[], fallback?: string }} args
       * @param {{ files?: AppFile[] }} [given]  data files Postbox read from the agent’s folders (#54); never from the call
       */
      show_app({ id, title, code, permissions = [], fallback }, given = {}) {
        const blockId = id ?? newId('app');
        const existing = rt.s.apps[blockId];
        if (existing?.sessionId === sessionId) return this.update_app({ id: blockId, code, permissions, title }, given);
        return this.show_block(
          {
            block: {
              id: blockId,
              type: 'app',
              version: 1,
              title: title ?? 'App',
              fallback: fallback ?? `${title ?? 'An app'}: open Postbox to use it.`,
              code,
              permissions,
            },
          },
          given,
        );
      },
      update_app(args, given) {
        return updateApp(rt, sessionId, turn, threadId, endSegment, args, given);
      },
      retire_app(args) {
        return retireApp(rt, sessionId, args);
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
        return { ok: true, message: inherited ? `Defined “${term}” here, over the conversation’s definition.` : `Defined “${term}”.` };
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
      wake_agent: (args) => wakeAgent(rt, sessionId, args),
      bring_to_conversation: (args = {}) => bringToConversation(rt, sessionId, turn, args),
      read_conversation(args = {}) {
        try {
          return { ok: true, message: rt.readConversation(se(), args) };
        } catch (e) {
          return { ok: false, message: e.message };
        }
      },
      read_message(args = {}) {
        return rt.readMessage(se(), args);
      },
      ask_for_tool(args = {}) {
        return askForTool(rt, sessionId, args, endSegment, threadId());
      },
      add_dataset(args) {
        return rt.addDataset(sessionId, args);
      },
      corpus_search(args) {
        return { ok: true, results: hostTool(rt, 'corpus.search', args) };
      },
    };
  }
}

const DATASET_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** Where a project’s datasets live: Postbox’s own folder in the project (#47). @param {string} folder */
const datasetDir = (folder) => join(folder, '.postbox', 'datasets');

/** What Postbox asks when you stop an agent whose background jobs are running (#129). */
export function stopAskText(handle, n) {
  return `@${handle} has ${n === 1 ? '1 background job' : `${n} background jobs`} running. Stop ${n === 1 ? 'it' : 'them'} too?`;
}
// Postbox never kills a job you kept (#164), but one with no process left under its agent couldn’t be kept either.
const KEEP_LOST = 'Postbox couldn’t find its process to keep it running: it may have ended with the agent, and Postbox can’t show it or stop it.';
/** What the person and the agent are told when Postbox couldn’t tell which of a turn’s processes a kept job was (#164). */
const keepUnsure = (n) => `Postbox couldn’t tell which of ${n} processes is this job, so it kept them all running; stopping the job stops them all.`;

/**
 * A kept job’s process groups, with their leaders’ command lines when it was kept (#164). A job kept before those were
 * recorded has only its pgid. Bounded and checked: these come from an adapter, or from saved state.
 * @param {{ pgid?: unknown, groups?: unknown }} job
 * @returns {{ pgid: number, command: string|null }[]}
 */
function keptGroupsOf(job) {
  const ok = (n) => Number.isInteger(n) && n > 1;
  if (Array.isArray(job.groups))
    return job.groups
      .filter((g) => ok(g?.pgid))
      .slice(0, 20)
      .map((g) => ({ pgid: g.pgid, command: typeof g.command === 'string' ? g.command.slice(0, 8000) : null }));
  return ok(job.pgid) ? [{ pgid: /** @type {number} */ (job.pgid), command: null }] : [];
}

/**
 * A kept job’s groups that are still its own: something is in them, and the leader, if still there, is the process it
 * was when the job was kept (or, for a job from before that was recorded, runs the job’s command). A group can’t lose
 * its id while anything is in it, but once it’s empty the id can go to another.
 * @param {{ pgid?: number, groups?: unknown, command: string }} job @param {import('./adapters/process-group.mjs').Proc[]} procs
 */
function liveGroups(job, procs) {
  return keptGroupsOf(job).filter((g) => {
    const members = procs.filter((p) => p.pgid === g.pgid);
    const leader = members.find((p) => p.pid === g.pgid);
    return members.length > 0 && (!leader || (g.command !== null ? leader.command === g.command : runsCommand(leader, job.command)));
  });
}

/** An error the ledger raised with a status, as the API answers it. */
const asHttp = (e) => {
  throw e?.status ? httpError(e.status, e.message) : e;
};
const snapshotOf = (p) =>
  pick(p, ['description', 'instructions', 'model', 'effort', 'permissionMode', 'usesHostSetup', 'canPublish', 'mcpOff', 'folder', 'tools', 'version']);
const MAX_MCP_OFF = 100;
/**
 * A persona’s setup choices (#57) are true or false, and the MCP servers it turned off (#59) a list of names;
 * anything else is refused. Absent means the default.
 */
function checkSetup({ usesHostSetup, canPublish, mcpOff }) {
  if (usesHostSetup !== undefined && typeof usesHostSetup !== 'boolean') throw httpError(422, '“Uses your Claude Code setup” is true or false.');
  if (canPublish !== undefined && typeof canPublish !== 'boolean') throw httpError(422, '“Can publish outside Postbox” is true or false.');
  if (
    mcpOff !== undefined &&
    (!Array.isArray(mcpOff) || mcpOff.length > MAX_MCP_OFF || mcpOff.some((n) => typeof n !== 'string' || !n.trim() || n.length > 200))
  )
    throw httpError(422, `The MCP servers turned off are a list of up to ${MAX_MCP_OFF} server names.`);
}
/** A persona’s effort is one of the levels Claude Code and the SDK take (#60). */
function checkEffort(effort) {
  if (!EFFORT_LEVELS.includes(effort)) throw httpError(422, `Effort is one of ${EFFORT_LEVELS.join(', ')}.`);
}
// Commands in the composer (#67), bounded: an agent’s list for the / menu, a `!command`’s output (its last
// characters), how often that output reaches the browser, and how much of it the agents read.
const MAX_COMMANDS = 200;
const MAX_COMMAND_OUTPUT = 64 * 1024;
const COMMAND_FLUSH_MS = 100;
const COMMAND_REFRESH_MS = 5000;
const MAX_COMMAND_REFRESHES = 60;
const COMMAND_CONTEXT = 4000;
// What a conversation keeps for the permissions panel (#66), bounded.
const MAX_CONVERSATION_RULES = 200;
const MAX_ADD_DIRS = 20;
/** Server names, trimmed and without repeats. Postbox’s own server can’t be turned off, so it’s dropped. */
const serverNames = (list) => [...new Set(list.map((n) => n.trim()))].filter((n) => n !== POSTBOX_SERVER);
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));

export { formatDuration };
