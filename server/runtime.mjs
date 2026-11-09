// The runtime: threads, sessions and turns. It decides who replies, wakes agents, enforces the wake
// limit, queues messages sent mid-reply, handles Stop, tracks what "needs you", and implements the UI
// tools that agents call (over MCP, or in-process for the mock).

import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, resolve, sep } from 'node:path';
import { ASKING } from '../shared/catalog.mjs';
import { COLUMN_PX, lintDiagrams, MIN_TEXT_PX, mermaidBlocks } from '../shared/diagram-lint.mjs';
import { READING } from '../shared/limits.mjs';
import { formatDuration, glimpseOf, parseMentions } from '../shared/text.mjs';
import { carriedList, turnLine } from '../shared/work.mjs';
import { describeTool } from './adapters/claude-stream.mjs';
import { workFolder } from './adapters/folder.mjs';
import { listProcesses } from './adapters/process-group.mjs';
import { AUTO_MODEL, DEFAULT_EFFORT, EFFORT_LEVELS, POSTBOX_SERVER } from './adapters/setup.mjs';
import { contentBlocks, listClaudeSessions, recentHistory, TranscriptTail, typedText } from './adapters/terminal-mirror.mjs';
import { agentFile, agentFolders, appFiles } from './agent-files.mjs';
import { retireApp } from './app-retire.mjs';
import { APP_HOLD_MAX, APP_SEND_LIMIT, APP_SEND_WINDOW_MS } from './app-send-limits.mjs';
import { appCheck, appEvent, appFile, appQuery, appState, fixEnded, needAppSend, registerApp, resolveAppSend, showApp, updateApp } from './apps.mjs';
import { restoreArchives } from './archive-lifecycle.mjs';
import { showBlock } from './block-show.mjs';
import { act, answerDelivered, unreadAnswer, updateBlock } from './blocks.mjs';
import { bringToConversation } from './bring.mjs';
import { keptTurns, nextNeed, noticeNeed, releaseNeed, stateFor, TURN_TIED } from './card-needs.mjs';
import { catchUp, moveMarkers, pointerIfSeen } from './catch-up.mjs';
import { blockProblems, diagramProblems, formatLint, introducedTerms, lintMessage, personSaid, rawHtmlProblems, termProblems } from './checks.mjs';
import { addDataset, reloadDatasets } from './datasets.mjs';
import { DELETE_UNDO_MS } from './delete-undo.mjs';
import { emptyReply, endedWithoutReply } from './empty-reply.mjs';
import { checkedSnapshot, folderOrNone, placedFolder, sessionFolder } from './folder-path.mjs';
import { heldSession } from './held-session.mjs';
import { clip, clipText, httpError } from './helpers.mjs';
import { hostTool } from './host-tool.mjs';
import { clipItem, describeItem, topicRootLine } from './item-lines.mjs';
import { keptGroupsOf, keptJobs, pollKept, stopJob, stopKeptJobs, watchKept } from './kept-jobs.mjs';
import { Ledger } from './ledger.mjs';
import { sendLint } from './lint-delivery.mjs';
import { wakeMentions } from './mention-wakes.mjs';
import * as queue from './message-queue.mjs';
import { alwaysFor } from './permission-always.mjs';
import {
  allowAlways,
  askPerson,
  expireStalePermissions,
  readsRules,
  recordDenial,
  requestPermission,
  resolveDenial,
  resolvePermission,
  settlePermission,
} from './permission-cards.mjs';
import {
  changePermissionFolder,
  changePermissionRule,
  latestProject,
  PERMISSION_MODES,
  panelTarget,
  permissionsView,
  setPermissionMode,
} from './permissions-panel.mjs';
import { checkEffort, checkSetup, handleOf } from './persona-checks.mjs';
import { arrival } from './queue-batch.mjs';
import { readCapped } from './read-capped.mjs';
import { readMessage } from './read-message.mjs';
import { addHost, host, removeHost, setProjectHostFolder, updateHost } from './remote/host-admin.mjs';
import { describeHostInstall, hostStatus, installHost, retryHost, watchHosts } from './remote/host-status.mjs';
import {
  hereFolder,
  localBackends,
  notHere,
  placedPatch,
  placement,
  refuseHere,
  refuseUnregistered,
  refuseUnregisteredSend,
  registeredAdapter,
  requestAdapter,
  runsHere,
} from './remote/placement.mjs';
import { RemoteTurns } from './remote/turns.mjs';
import { replySegment, stepTaken, wordsSegment } from './reply-segment.mjs';
import { reviewBlock } from './review-comments.mjs';
import { cancelWake } from './schedule-tools.mjs';
import {
  armWake,
  cancelWakeSchedule,
  dropScheduledWake,
  prepareScheduledRetry,
  rearmWakes,
  recordedTools,
  recordScheduledTool,
  scheduleWake,
  settleScheduledWake,
} from './scheduled-wakes.mjs';
import { setSessionRun } from './session-run.mjs';
import { pendingSessionsIn, tellAgent, updateSession } from './session-write.mjs';
import { clearSummaryPending, shareText, shareToConversation, summarizeBack, summarizing } from './share-back.mjs';
import { runShell } from './shell.mjs';
import {
  agentWake,
  archiveForks,
  bumpSideLink,
  dropWakes,
  endChain,
  recordAgentMessage,
  resolveHop,
  sideSession,
  threadPersona,
  wakeAgent,
} from './side-threads.mjs';
import { newId } from './store.mjs';
import { heldTurn, STORE_STOPPED, saveBackendState, watchStore, whenWritable } from './store-outage.mjs';
import { endSubagent, notUrgent } from './subagent-end.mjs';
import { conversationDeleting, discardHeld, eraseThreads, releaseHeld } from './thread-erase.mjs';
import { firstPromptSection, settleThread, turnContext } from './thread-summary.mjs';
import { updateThread } from './thread-write.mjs';
import { askForTool, settleToolAsks } from './tool-ask.mjs';
import { openTopic, startTopic } from './topic-open.mjs';
import { askedAgain, askedOf, replyMarks, wokeOf } from './turn-marks.mjs';
import { settleStoppedSteps, settleSubagentSteps } from './turn-steps.mjs';
import { workEvents } from './turn-work.mjs';
import { closeOrphanCards, liftDecline, retireStale } from './wake-cards.mjs';

export { AgentFileError } from './agent-files.mjs';
export { httpError } from './helpers.mjs';
export { hostTool } from './host-tool.mjs';
export { HOP_LIMIT } from './side-threads.mjs';
export { PERMISSION_MODES, readCapped };

/** @typedef {import('./agent-files.mjs').AppFile} AppFile */

const STEP_STATES = new Set(['running', 'done', 'failed', 'denied', 'stopped']);
/** What a step is when it isn’t a tool call (#73): a thought, a subagent’s narration, or a subagent’s own step. */
const STEP_KINDS = /** @type {Set<unknown>} */ (new Set(['thought', 'said', 'agent']));
/** The background jobs Postbox keeps on a session, at most. */
const MAX_JOBS = 50;
/** How long a stopped turn may hold its session before Postbox lets the next turn start anyway, and says so (#126). */
const STOP_WATCHDOG_MS = 15000;
/** The model a real backend uses when a persona doesn’t name one. */
export const DEFAULT_MODEL = 'claude-opus-5-5';
export class Runtime {
  /**
   * @param {{ store: import('./store.mjs').Store, adapters: import('./adapters/adapter.mjs').AdapterRegistry,
   *           corpus: import('./corpus.mjs').Corpus, config: { origin: string, imageOrigins: string[], claudeProjectsRoot?: string, versions?: any, lintSettleMs?: number, home?: string, build?: { version?: string } },
   *           blobs?: import('./blobs.mjs').Blobs, narrator?: import('./narration/narrator.mjs').Narrator|null,
   *           spawnShell?: typeof import('node:child_process').spawn, signalProcess?: import('./adapters/process-group.mjs').KillFn,
   *           listProcesses?: () => Promise<import('./adapters/process-group.mjs').Proc[]>, ledger?: Ledger,
   *           hosts?: import('./remote/hosts.mjs').HostManager | null }} deps
   *   spawnShell: how `!command` starts a process (#67); signalProcess and listProcesses: how a background job Postbox
   *   kept running is signaled, and found to check it’s still the same process (#129). Tests pass fakes.
   *   ledger: the work ledger (#132); tests pass one with fake files and git
   *   hosts: the remote hosts’ manager (#120, server/remote/hosts.mjs), which reaches each host’s daemon; without it,
   *   nothing runs on a host. Tests pass a fake.
   */
  constructor({ store, adapters, corpus, config, blobs, narrator, spawnShell, signalProcess, listProcesses: list, ledger, hosts }) {
    this.store = store;
    // While the store can’t be written, no turn runs or starts, and what would write waits (ST-3, server/store-outage.mjs).
    /** @type {(() => void)[]} */
    this.storeWait = [];
    /** @type {Map<string, Promise<void>>} a persona’s purge runs, chained one at a time (persona-delete.mjs) */
    this.personaPurges = new Map();
    /** @type {Map<string, Record<string, any>>} a backend’s state saved meanwhile, per session, merged (saveBackendState) */
    this.backendWait = new Map();
    watchStore(this);
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
    this.permissionWaits = new Map(); // permission item id → { resolve, threadId, sessionId, timer }
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
    /** @type {Map<string, [any, any][]>} what deliver held for a session in its Undo window (#597), in arrival order */
    this.heldForUndo = new Map();
    this.lints = new Map(); // agent turn id → its lint turn, gathering: { sessionId, kind, ended, sent, problems, timer }
    this.spawnShell = spawnShell ?? undefined;
    this.shellRuns = new Map(); // command item id → { stop, kill, done, flush, stopped, closing }
    // What each conversation’s agents changed, ran and published (#132).
    this.ledger = ledger ?? new Ledger({ store, blobs: this.blobs, home: this.home });
    // Turns of agents whose persona runs on a remote host (#120): server/remote/turns.mjs.
    this.hosts = hosts ?? null;
    this.remote = new RemoteTurns(this, { hosts: this.hosts });
    // Forks are gone (#228): any left from before are archived, once.
    archiveForks(this);
    // Nothing archives a conversation by itself any more (#320): what idle archiving hid comes back, once.
    restoreArchives(this);
    // After the restore, so a card it brings back stays the person’s to answer (#693).
    closeOrphanCards(this);
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
        ...checkedSnapshot(se.personaSnapshot ?? {}),
        backend: p.backend,
        permissionMode: p.permissionMode ?? 'auto',
        // Whether it loads your Claude Code setup and may publish outside Postbox are permissions too (#57), and
        // so are the MCP servers it turned off (#59) and its tools, which real backends deny when unticked (#5).
        usesHostSetup: p.usesHostSetup !== false,
        canPublish: p.canPublish === true,
        mcpOff: p.mcpOff ?? [],
        skillsOff: p.skillsOff ?? [],
        tools: p.tools ?? [],
      }
    );
  }
  personaByHandle(handle) {
    return Object.values(this.s.personas).find((p) => p.handle.toLowerCase() === String(handle).toLowerCase() && !p.retired && !p.deleting);
  }
  /** Whether a persona being deleted holds this name: it keeps it until its Undo window ends, so Undo never makes two (#208). */
  deletingHandle(handle) {
    return Object.values(this.s.personas).some((p) => p.deleting && p.handle.toLowerCase() === String(handle).toLowerCase());
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
    // A reply in a topic thread counts on the message it branched from, as “3 replies”: one maybe just opened, held (#796).
    const t = this.store.pending.thread(threadId);
    if (t?.kind === 'topic' && (it.kind === 'user' || it.kind === 'agent')) {
      const replies = this.store.pending.items(threadId).filter((x) => x.kind === 'user' || x.kind === 'agent').length;
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
   * Ends the turn’s current segment as done, as a card does when it opens: the reply goes on below the card. The turn
   * keeps the id of its one segment still streaming (openSegment), because an item held behind a commit isn’t in
   * store.items() yet, so the turn’s end and Stop find it by id, not by a scan (gpt’s peer read of the Stop fix). A tool
   * call or a compaction clears the segment without ending it, so it stays the open one.
   * @param {any} turn
   */
  closeSegment(turn) {
    if (turn.segment) this.patchItem(turn.threadId, turn.segment, { status: 'done' });
    if (turn.openSegment === turn.segment) turn.openSegment = null;
    turn.segment = null;
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
    const items = this.store.pending.items(threadId);
    const i = items.findIndex((x) => x.id === id);
    if (i < 0) return false;
    if (i === items.length - 1) {
      if (Object.keys(patch).length) this.patchItem(threadId, id, patch);
      return false;
    }
    const now = Date.now();
    const st = { id: newId('it'), kind: 'moved', at: now, itemId: id, ...stub, ...carriedList(items[i]).stub };
    this.store.emit('item.move', { threadId, id, stub: st, patch: { ...patch, ...carriedList(items[i]).item, at: now, movedAt: now } });
    moveMarkers(this, threadId, id, st.id);
    return true;
  }
  updateSession(id, patch) {
    updateSession(this, id, patch);
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
    this.thread(threadId);
    const existing = pendingSessionsIn(this, threadId).find((x) => x.personaId === personaId);
    if (existing) return existing;
    const p = this.persona(personaId);
    if (!p) throw httpError(404, 'That agent doesn’t exist.');
    // It would outlive its persona, and a turn there would make its memory again (#208).
    if (p.deleting) throw httpError(409, `@${p.handle} is being deleted. Undo that first to add it to a conversation.`);
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
      archived: false,
      brief: brief ?? null,
      // The person never added it, so its row says why it’s here (decided by the person, 23 October 2026).
      ...(joined ? { joinedBy: joined.by, joinedIn: joined.in } : {}),
      // Nothing given yet: its first turn starts with the conversation so far (see catchUp).
      seenItem: null,
    });
    updateThread(this, threadId, (x) => ({ members: [...x.members, se.id], kind: x.kind === 'thread' && x.members.length > 0 ? 'room' : x.kind }));
    liftDecline(this, threadId, p.handle); // the person added it: a decline of adding it here no longer holds (#789)
    return se;
  }

  // ── Messages from you ──────────────────────────────────────────────────────────────

  /** You send a message: @mentions wake agents (joining them to the thread); otherwise the last speaker replies. */
  sendMessage(threadId, { text = '', attachments = [], sendNow = false } = {}) {
    const t = this.thread(threadId);
    if (this.store.pending.thread(threadId)?.deleting) throw httpError(409, 'This conversation is being deleted. Undo it first.');
    text = String(text).slice(0, 50000);
    if (!text.trim() && !attachments.length) throw httpError(400, 'Write a message or attach a file first.');
    const mentioned = parseMentions(text, this.handles())
      .map((h) => this.personaByHandle(h))
      .filter(Boolean);
    const targets = [];
    // A side or topic thread is answered by the conversation’s own sessions (#110, #128, #228): an agent you
    // @-mention there, or the one you reply to, answers from its one session in the conversation, and the reply shows here.
    // Side threads from before #372 are history: agents talk in the conversation now.
    if (t.kind === 'side') throw httpError(409, 'Side threads are read-only now. Write in the conversation, where the agents talk.');
    // Refuse before anything is posted or joined: a turn for an agent whose backend isn’t registered couldn’t start (#874).
    refuseUnregisteredSend(this, mentioned);
    const away = t.kind === 'topic';
    if (away) {
      for (const p of mentioned) targets.push({ se: this.sideSession(t, p.id, 'you') });
      if (!targets.length) {
        // The last speaker’s agent replies, as in a conversation; before anyone has, the agent it started with.
        const p = threadPersona(this, t);
        // Refused before sideSession, which would join an agent not yet in the conversation (#874).
        if (p) refuseUnregisteredSend(this, [p]);
        const se = p && this.sideSession(t, p.id, 'you');
        if (!se) throw httpError(409, 'No agent is in this thread. @-mention one to bring it in.');
        targets.push({ se });
      }
    }
    // Refuse before anything is posted, so a refused message doesn’t also appear in the transcript.
    const archived = mentioned.map((p) => this.sessionsIn(threadId).find((x) => x.personaId === p.id)).find((x) => x?.archived);
    if (archived && !away) throw httpError(409, `@${archived.handle}’s session is archived. Restore it first.`);
    for (const p of away ? [] : mentioned) {
      const joined = !this.sessionsIn(threadId).some((x) => x.personaId === p.id);
      targets.push({ se: this.ensureSession(threadId, p.id, { brief: joined ? 'You were @-mentioned into this thread.' : null }) });
    }
    if (!targets.length) {
      const members = this.sessionsIn(threadId).filter((x) => !x.archived);
      const last = members.find((x) => x.id === t.lastSpeaker) ?? members[0];
      if (!last) throw httpError(409, 'No agent is in this thread. @-mention one to bring it in.');
      targets.push({ se: last });
    }
    // And the agent you reply to, as the mentioned ones above.
    const woken = targets.map(({ se }) => this.persona(se.personaId));
    refuseUnregisteredSend(this, woken);
    // Messages to a busy agent wait in the queue unless you choose Send now.
    const busy = targets.filter(({ se }) => this.turns.has(se.id));
    const q =
      busy.length && !sendNow ? { id: newId('q'), text, attachments, sessionIds: targets.map(({ se }) => se.id), at: Date.now(), seq: arrival() } : null;
    if (q) updateThread(this, threadId, (x) => ({ queue: [...(x.queue ?? []), q] }));
    // Send now is a change of course: background jobs keep running, each with its own Stop (#129).
    else for (const { se } of busy) this.stop(se.id, { silent: true, jobs: 'keep', sendNow: true });
    const sent = q ? { queued: q } : this.postAndDeliver(threadId, { text, attachments }, targets);
    // A card waiting to wake one of them is stale now (#439), whether this went at once or waits in the queue. It
    // retires after, so the wake you never allowed goes behind your message rather than ahead of it.
    for (const { se } of targets) retireStale(this, threadId, se, 'you wrote to it', { byPerson: true });
    return sent;
  }

  postAndDeliver(threadId, { text, attachments }, targets) {
    return queue.postAndDeliver(this, threadId, { text, attachments }, targets);
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
    return queue.editQueued(this, threadId, queueId, text);
  }

  cancelQueued(threadId, queueId) {
    return queue.cancelQueued(this, threadId, queueId);
  }

  /** Send now: stops the agent’s current turn and delivers the queued message at once. */
  sendQueuedNow(threadId, queueId) {
    return queue.sendQueuedNow(this, threadId, queueId);
  }

  /** Once Postbox listens after a restart: what waited in the queues goes now, a wake or a message of yours (#228). */
  drainAll() {
    return queue.drainAll(this);
  }

  /**
   * Sends what can go from a thread’s queue: every item whose agents are free, in order for each agent, so one waiting
   * for a busy agent holds back nothing for another (#228). wakesOnly: only agents’ wakes, after a failed turn, when
   * your own messages wait for you to see the failure.
   */
  drainQueue(threadId, wakesOnly = false) {
    return queue.drainQueue(this, threadId, wakesOnly);
  }

  // ── Turns ──────────────────────────────────────────────────────────────────────────

  /**
   * Runs one agent turn through its adapter.
   * threadId: where the turn speaks, when that isn’t the session’s own thread: a conversation session answers in a side
   * thread (#110), so one persona has one memory per conversation.
   * @param {string} sessionId @param {any} message
   * @param {{ summarizeTo?: string|null, threadId?: string|null }} [opts]
   */
  deliver(sessionId, message, { summarizeTo = null, threadId = null } = {}) {
    // A session just made behind a held commit: its turn starts once it's published (#796's class in sessions).
    if (heldSession(this, sessionId, () => this.deliver(sessionId, message, { summarizeTo, threadId }))) return;
    const se = this.store.pending.session(sessionId) ?? this.session(sessionId); // a summary's or a notice's write held (#506)
    if (se.archived) throw httpError(409, `@${se.handle}’s session is archived. Restore it first.`);
    // An agent being deleted, or in a conversation being deleted (#725), starts no turn in its Undo window: every path
    // that delivers comes through here, so one check covers them all (#597 review). What arrives is held, not dropped:
    // Undo delivers it in order, the purge drops it with the session (critic). Queued messages wait in the queue (R1).
    if (se.deleting || conversationDeleting(this, se.threadId)) {
      this.heldForUndo.set(sessionId, [...(this.heldForUndo.get(sessionId) ?? []), [message, { summarizeTo, threadId }]]);
      return;
    }
    message = prepareScheduledRetry(this, message, se.threadId);
    // As it was asked, for Retry (askedOf).
    const asked = { message, summarizeTo, threadId };
    // The store can’t be written: the turn starts once it can (ST-3).
    if (heldTurn(this, sessionId, () => this.deliver(sessionId, asked.message, { summarizeTo, threadId }), message)) return;
    if (this.turns.has(sessionId)) {
      // Agent-to-agent messages and events wait for the current turn to end.
      const t = this.turns.get(sessionId);
      t.pending.push({ message: { ...message, at: message.at ?? Date.now(), seq: message.seq ?? arrival() }, summarizeTo, threadId });
      return;
    }
    // A stopped turn’s process is still exiting: the next turn waits for it, so a session never runs two (#126). An answer
    // held here isn’t read yet: it’s read when the turn it starts begins.
    const exiting = this.exiting.get(sessionId);
    if (exiting) {
      exiting.held.push({ message: { ...message, at: message.at ?? Date.now(), seq: message.seq ?? arrival() }, summarizeTo, threadId });
      return;
    }
    // Shutting down: a new CLI would outlive Postbox. A message you sent waits in the queue (turnExited).
    if (this.closing) return;
    const where = threadId && threadId !== se.threadId && this.store.pending.thread(threadId) ? threadId : se.threadId;
    this.answerDelivered(where, message);
    // A skill or command (#67) is the whole prompt, since Claude Code runs it only when the prompt starts with /name:
    // the context below waits for the agent’s next turn instead. So does a remote turn attached again after a restart
    // (#120, message.attach): it sends the agent nothing, and replays what the host has.
    const slash = message.slash === true || typeof message.attach === 'string';
    // A queued mention its last room summary already gave it comes as a pointer there, never as a thread’s direct task (#484, #504).
    if (where === se.threadId) message = pointerIfSeen(this, se, message);
    // Postbox’s notices that waited for this agent’s next turn (tellAgent: what became of its earlier messages) lead the
    // background; the brief isn’t context, it goes with the room’s facts (turnFacts).
    if (se.context?.length && !slash) {
      // Not an urgent note to stop a subagent (#229): its turn ended, and the subagent with it.
      message = { ...message, context: [...notUrgent(se.context), ...(message.context ?? [])] };
      this.updateSession(sessionId, (now) => ({ context: (now.context ?? []).filter((/** @type {string} */ x) => !se.context.includes(x)) })); // only what it read
    }
    // Problems the checks found in its last reply, still waiting to go as a lint turn, come with this turn instead, as
    // message.lint: fixes it owes, placed with the request rather than in the background.
    if (message.kind !== 'lint' && !slash) message = this.foldLint(sessionId, message);
    // A topic or side thread’s request leads; its room catch-up is background. A room turn keeps the existing order.
    message = turnContext(this, this.store.pending.session(sessionId) ?? this.s.sessions[sessionId], where, message, slash);
    const persona = this.persona(se.personaId);
    const adapter = registeredAdapter(this, persona);
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
      // The backend it started on: a persona changed mid-turn reaches the next turn, not this one (#220).
      backend: persona?.backend ?? 'mock',
      threadId: where,
      promptFirst: firstPromptSection(message, where !== se.threadId),
      segment: null,
      first: null,
      steps: [],
      abort,
      closed: false,
      summarizeTo,
      checkpoint: null,
      pending: [],
      said: '',
      rawTail: [],
      // A skill or command, or a host turn attached again: it may end with nothing to say, as /compact does (#485).
      slash,
      // Agents the failed reply this retries already woke: its mentions don’t wake them again (#485).
      woken: Array.isArray(message.woken) ? message.woken : [],
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
    // A persona on a remote host (#120): the turn is remote from here on (server/remote/turns.mjs).
    const hostId = adapter ? this.remote.hostOf(persona) : null;
    if (hostId) this.remote.begin(turn, hostId, adapter);
    // The work ledger (#132) follows the turn’s tool calls. A change outside the project’s folder and the agent’s is
    // flagged; the adapter knows the agent’s folder. A remote agent’s folder is on its host, never made here.
    const project = this.s.projects[this.s.threads[se.threadId]?.projectId] ?? null;
    this.ledger.startTurn(turn, {
      se,
      folder: hostId ? null : workFolder(adapter, persona, project),
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
      // Moving on clears a need tied to a turn; the cards that wait until answered stay (card-needs.mjs RANK).
      needs: turn.movesOn && TURN_TIED.has(se.needs?.kind) ? null : se.needs,
      // This turn is the last turn from its start (card-needs.mjs turnsOf), so a restart that cuts it off, or a card
      // released after it leaves the running turns, doesn't count a block from the turn before.
      lastTurnId: turn.id,
      // A turn that doesn't move on keeps the turns still asking you something, so their refusals and tool requests
      // count until you move on (card-needs.mjs keptTurns). Read before this patch moves lastTurnId on.
      keptTurnIds: turn.movesOn ? [] : keptTurns(this, se),
      // A turn that doesn't move on keeps the block it found waiting (#69): it counts mid-turn, at the turn's end and
      // after a restart (card-needs.mjs `keep`), even if a permission takes the need meanwhile. In the store, as above.
      keptId: !turn.movesOn && se.needs?.kind === 'block' ? se.needs.itemId : null,
      currentStep: 'Thinking',
      finishedAt: null,
    });
    // With the turn’s last raw lines, which each adapter’s recorder keeps (recorderFor), for an empty reply (#485).
    const ctx = Object.assign(this.turnContext(se, turn), { rawTail: turn.rawTail });
    // A remote turn has its host’s welcome, its host turn and the conversation’s snapshot before the adapter starts.
    const run = Promise.resolve().then(async () => {
      if (!adapter) refuseUnregistered(se, persona);
      if (!hostId) refuseHere(this, se, persona);
      return adapter.deliver(this.s.sessions[sessionId], hostId ? await this.remote.prepare(turn, ctx, message) : message, ctx);
    });
    turn.exited = run.then(
      () => {},
      () => {},
    );
    run.then(
      () => this.endTurn(turn, null),
      (err) => this.endTurn(turn, err),
    );
    // The chain’s count resets once the chain ends (#541). While the store can’t be written, that write waits behind the
    // exit’s own (turnExited), which also waits, so it runs after the session has left exiting and sees the chain ended.
    void turn.exited.then(() => this.turnExited(turn)).then(() => whenWritable(this, () => endChain(this, turn.threadId)));
  }

  turnContext(se0, turn) {
    const rt = this;
    const live = () => !turn.closed;
    const se = () => rt.s.sessions[turn.sessionId];
    const ensureSegment = () => replySegment(rt, turn, se0);
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
      saveState: (patch) => saveBackendState(rt, turn.sessionId, patch),
      /** Where an attachment can be read on disk, or null. */
      pathOf: (a) => rt.attachmentPath(turn.threadId, a),
      /**
       * Asks the person in the thread; resolves to { allow, message?, updatedInput?, updatedPermissions? }. On a remote
       * turn, req.hostPrompt names the prompt as the host knows it (a Codex request’s codex:<id>), so the host’s
       * expiry of it marks the card (#120).
       */
      askPermission: (req) => (turn.remote ? rt.remote.ask(turn, req) : rt.requestPermission(turn.sessionId, req)),
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
      // For the work ledger (#132): toolUse, toolResult, taskEnded and usage (turn-work.mjs).
      ...workEvents(rt, turn, live),
      /**
       * Where this turn ends in the backend’s own transcript, such as { claudeSessionId, uuid }. A topic
       * thread that branches from this turn’s messages forks the agent’s session there.
       */
      checkpoint(ref) {
        turn.checkpoint = ref;
      },
      text(delta) {
        if (!live() || !delta) return;
        const id = wordsSegment(rt, turn, se0);
        turn.said += delta;
        rt.store.emit('item.text', { threadId: turn.threadId, id, text: delta });
        if (rt.store.pending.session(turn.sessionId)?.state !== 'gen') rt.updateSession(turn.sessionId, { state: 'gen', currentStep: 'Writing a reply' });
      },
      // who: the subagent that took the step; parent nests it under its starting step; detail holds an error,
      // thought, narration or subagent result; kind names non-tool work; job names its background job (#73, #129).
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
        if (!who) stepTaken(turn);
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
        if (turn.first) rt.store.emit('item.patch', { threadId: turn.threadId, id: turn.first, activityStep: step });
        // A thought or a subagent’s narration is in the list, but it isn’t a tool call.
        if (kind === 'thought' || kind === 'said') return;
        if (state === 'running' && !who) recordScheduledTool(rt, turn, { id, name: label }, false);
        // A subagent’s step is its own: it moves its arc, not the agent’s state or step (#189).
        const own = state === 'running' && !(i >= 0 ? turn.steps[i] : step).who;
        // From the pending session: behind a held commit each call still counts, and the list keeps each (#796's class).
        rt.updateSession(turn.sessionId, (s) => ({
          state: own ? 'tool' : s.state,
          toolCalls: [{ name: step.label, state: step.state, ms: step.ms }, ...s.toolCalls.filter((c) => c.name !== step.label)].slice(0, 5),
          toolCount: s.toolCount + (i >= 0 ? 0 : 1),
          currentStep: own ? step.label : s.currentStep,
        }));
      },
      status(patch) {
        if (!live()) return;
        const allowed = {};
        if (patch.state && ['think', 'gen', 'tool'].includes(patch.state)) allowed.state = patch.state;
        if (patch.ctx === null || typeof patch.ctx === 'number') allowed.ctx = patch.ctx === null ? null : Math.max(0, Math.min(100, Math.round(patch.ctx)));
        if (Array.isArray(patch.subagents))
          // Each with what it was asked, its step now, its latest narration and the subagent that started it (#73).
          allowed.subagents = patch.subagents.slice(0, 12).map((x) => ({
            ...(typeof x.id === 'string' && x.id ? { id: x.id.slice(0, 100) } : {}),
            name: String(x.name).slice(0, 40),
            state: x.state,
            ctx: Number.isFinite(x.ctx) ? Math.max(0, Math.min(100, x.ctx)) : null, // null: unknown (#189)
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
        if (typeof patch.glimpse === 'string') allowed.glimpse = glimpseOf(patch.glimpse);
        rt.updateSession(turn.sessionId, allowed);
      },
      compaction({ kept, total, summary }) {
        if (!live()) return;
        const n = (rt.store.pending.session(turn.sessionId) ?? se()).compactions + 1; // one held behind a commit counts too
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
    return (
      this.ledger
        .endTurn(turn, { status })
        .then(() => {
          const line = turn.work ? turnLine(this.ledger.entries(turn.work.convId), turn.id) : null;
          const last = this.store.pending.items(turn.threadId).findLast((x) => x.turnId === turn.id && (x.kind === 'agent' || (x.kind === 'block' && x.valid)));
          if (line && last) this.patchItem(turn.threadId, last.id, { work: line, workTurn: turn.id });
        })
        // Its callers don’t await it: a ledger that fails here must not become an unhandled rejection.
        .catch((e) => console.error(`@${turn.work?.se?.handle ?? 'an agent'}’s turn work wasn’t recorded: ${e instanceof Error ? e.message : e}`))
    );
  }

  endTurn(turn, err) {
    if (turn.closed) return;
    turn.closed = true;
    // Its permissions expire while it still counts as running, so their release counts no card tied to a turn: the
    // turn's end, below, decides those.
    for (const [id, w] of this.permissionWaits) if (w.sessionId === turn.sessionId) this.settlePermission(id, 'expired');
    this.turns.delete(turn.sessionId);
    this.settleSubagentSteps(turn);
    // How a remote turn ended on its host decides what the person sees: Sign-in needed and Interrupted say so (#120).
    if (turn.remote) err = this.remote.ended(turn, err);
    settleScheduledWake(this, turn, err);
    this.endWork(turn, !err ? 'done' : err.name === 'AbortError' ? 'stopped' : 'failed');
    // The turn’s own lines in an attached session’s transcript aren’t terminal activity.
    this.mirrors.get(turn.sessionId)?.tail.skipToEnd();
    const se = this.s.sessions[turn.sessionId];
    if (!se) return;
    const items = this.store.pending.items(turn.threadId);
    // A turn that ends with no reply is never posted as an empty message (#485, empty-reply.mjs): it fails, saying so.
    if (!err && endedWithoutReply(turn, items)) err = emptyReply(this, se, turn);
    // The open segment by its id, even while held behind a commit; then any other still streaming in the visible state.
    if (turn.openSegment) this.patchItem(turn.threadId, turn.openSegment, { status: err ? 'failed' : 'done' });
    for (const it of items)
      if (it.turnId === turn.id && it.kind === 'agent' && it.status === 'streaming' && it.id !== turn.openSegment)
        this.patchItem(turn.threadId, it.id, { status: err ? 'failed' : 'done' });
    turn.openSegment = null;
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
    // Posted or not, the summary isn’t pending any more, so Summarize back works again, unless one waits behind this
    // turn (#225). Any turn ending clears one a restart left behind, too.
    this.clearSummaryPending(turn.threadId, turn);
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
          ...replyMarks(turn),
        }).id;
      this.patchItem(turn.threadId, target, {
        status: 'failed',
        error: message,
        retry: turn.retry ?? null,
        asked: askedOf(turn),
        ...(err.remote ? { remote: err.remote } : {}),
        ...(err.rawEnding ? { rawEnding: err.rawEnding } : {}),
      });
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
      // Its @-mentions still wake their agents (#485, the person’s choice): what it wrote may be cut off, so they’re told.
      // Not a host turn that goes on (Interrupted, Sign-in needed, its link lost): it wakes them when it ends.
      // The item keeps whom they woke, with those the failures before it woke, so no Retry wakes them again.
      const wakes = turn.said.trim() && !err.remote && se.remoteTurn?.state !== 'lost';
      const woke = wakes ? this.wakeMentions(se, turn, `(This reply failed before it finished: ${message} It may be cut off.)\n\n${turn.said}`) : [];
      if (woke.length || turn.woken.length) this.patchItem(turn.threadId, target, { wokeOnFailure: [...new Set([...turn.woken, ...woke])] });
      // A wake that waited for this turn still goes: with no forks, it was promised an answer (#228). Your own
      // queued messages wait, as before, for you to see the failure.
      this.takePending(se, turn, 'wakes');
      return;
    }
    // An app-check turn that ended without a new version: show the app with a note, or crashed (#964), not wait forever.
    if (turn.kind === 'app-check') {
      for (const app of Object.values(this.store.pending.apps()))
        if (app.sessionId === se.id && app.check.status === 'fixing') this.store.emit('app', { ...app, check: { ...app.check, status: fixEnded(app) } });
    }
    // Only this turn’s asking blocks make the agent need you. Older ones you left open stay open, and the
    // client shows them quietly (“1 open review”), so moving on clears needs-you (#69). A turn you didn’t start
    // (a lint or app-check pass, another agent’s wake or review) isn’t moving on: the block it was waiting on still counts.
    const open = items.filter(
      (it) => it.kind === 'block' && it.turnId === turn.id && it.sessionId === se.id && it.valid && ASKING.has(it.block.type) && !it.answered,
    );
    const waiting = se.keptId ? items.find((it) => it.id === se.keptId) : null;
    if (!open.length && waiting && !waiting.answered) open.push(waiting);
    const last = [...items].reverse().find((it) => it.kind === 'agent' && it.sessionId === se.id && it.text);
    const viewing = this.isViewing(turn.threadId);
    const topic = turn.threadId !== se.threadId && this.store.pending.thread(turn.threadId)?.kind === 'topic' ? turn.threadId : null;
    // The newest card that still waits (card-needs.mjs): this turn's asks, the kept turns' (a failed reply's Retry
    // among them), and the cards that wait until answered.
    const needs = nextNeed(this, se, { turnIds: [turn.id, ...(se.keptTurnIds ?? [])], keep: waiting?.id ?? null });
    const mentionsYou = /(^|\W)@you\b/i.test(turn.said);
    this.updateSession(se.id, (se) => ({
      state: stateFor(needs),
      needs,
      sideTurn: null,
      glimpse: '',
      subagents: [],
      currentStep: needs ? 'Waiting for you' : `Idle since ${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })}`,
      lastMessage: last ? clip(last.text) : se.lastMessage,
      finishedAt: Date.now(),
      // A reply in a topic thread counts on the thread, not the conversation it answers from (#228). The count is the
      // pending session's (se, here): behind a held commit, the published one lost the increment of a turn before.
      unread: topic ? se.unread : viewing ? 0 : se.unread + (turn.said || open.length ? 1 : 0),
      stopAsk: null,
    }));
    noticeNeed(this, se, needs);
    if (needs && (needs.kind === 'block' || needs.kind === 'denial' || needs.kind === 'toolask'))
      this.notify('blocking', se, `@${se.handle} needs you`, needs.text, needs.threadId);
    else if (mentionsYou && !viewing) this.notify('info', se, `@${se.handle} mentioned you`, clip(turn.said, 120), turn.threadId);
    else if (turn.said && !viewing) this.notify('info', se, `@${se.handle} finished`, clip(turn.said, 120), turn.threadId);

    // The checks: what this turn sent, as problems, which go back to the agent in one lint turn. A lint turn is
    // never linted again, so this can’t loop; one that only called tools ends as a note instead of a reply.
    const stalled = this.stallSteps(turn, se);
    if (turn.kind === 'lint') this.quietLint(turn, se);
    else this.endLint(turn, [...this.checkTurn(turn, se), ...stalled]);
    if (topic && !viewing && (turn.said || open.length)) updateThread(this, topic, (x) => ({ unread: (x.unread ?? 0) + 1 }));
    if (turn.threadId !== se.threadId) settleThread(this, turn.threadId);

    this.wakeMentions(se, turn, turn.said);
    this.takePending(se, turn, true);
  }

  /** The wakes a turn's @-mentions make once it ends (server/mention-wakes.mjs). */
  wakeMentions(se, turn, text) {
    return wakeMentions(this, se, turn, text);
  }

  /**
   * What waited for a turn that ended: the next message, with the rest behind it; with none, the queues (drain), or
   * only agents’ wakes waiting there (drain: 'wakes').
   */
  takePending(se, turn, drain) {
    return queue.takePending(this, se, turn, drain);
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
    return queue.drainQueues(this, sessionId, threadId, wakesOnly);
  }

  /**
   * Stop ends this agent’s turn and its subagents. Agents it woke keep running. Its process gets SIGINT, then SIGKILL,
   * and the session shows as stopping until it has exited: its next turn waits for that (#126).
   * jobs: what happens to the background jobs the turn started (#129): 'stop' them with it, or 'keep' them running,
   * each with its own Stop.
   * by: 'shutdown' when Postbox stops it as it shuts down, which the agent hears in those words; 'hung' when a remote
   * turn had no output for its host’s stallTimeout (#120), with why: what the person sees. sendNow: your message
   * with Send now stopped it, which its reply says, as it says when you kept its jobs running (#215, #249).
   * A remote turn’s Stop is always a plain stop: the daemon stops the whole turn, so no job is kept (#120).
   * @param {string} sessionId
   * @param {{ silent?: boolean, jobs?: 'stop' | 'keep', by?: 'you' | 'shutdown' | 'hung', why?: string, sendNow?: boolean }} [opts]
   */
  stop(sessionId, { silent = false, jobs = 'stop', by = 'you', why, sendNow = false } = {}) {
    const turn = this.turns.get(sessionId);
    if (!turn) return false;
    const keep = jobs === 'keep' && !turn.remote ? this.runningJobs(sessionId, turn.id) : [];
    turn.keepJobs = new Set(keep.map((j) => j.id));
    turn.stopReason = sendNow ? 'send-now' : by === 'shutdown' ? null : keep.length ? 'kept-jobs' : 'stop';
    const ended = { status: 'stopped', stoppedAt: Date.now(), stopReason: turn.stopReason };
    this.exiting.set(sessionId, { turn, held: [], silent });
    // The adapter reads which jobs to keep from the reason; anything else only sees that the turn was aborted.
    turn.abort.abort(Object.assign(new Error('Stopped by you.'), { name: 'AbortError', keepJobs: keep.map((j) => ({ id: j.id, command: j.command })) }));
    turn.closed = true;
    this.turns.delete(sessionId);
    this.recordStopped(turn, ended, { by, why: 'You stopped the agent.' });
    this.updateSession(sessionId, { state: 'stopping', subagents: [], currentStep: 'Stopping', finishedAt: Date.now(), stopAsk: null });
    // Progress steps running as you keep its jobs running may follow one of them: they run on with it (#129).
    if (keep.length) this.updateSession(sessionId, { heldSteps: { threadId: turn.threadId, keys: this.runningProgress(turn.threadId, sessionId) } });
    // Its progress steps still running show as stalled, as at any turn’s end (#98); you stopped it, so no lint turn.
    // Pending, so the heldSteps just written holds its steps behind a held commit too (#1042).
    const se = this.store.pending.session(sessionId);
    if (se) this.stallLeftRunning(turn, se, by === 'shutdown' ? 'shutdown' : by === 'hung' ? 'hung' : 'stopped');
    if (turn.remote) this.remote.stopped(turn, { by, why });
    // A process that never exits mustn’t hold the session for good: after a while, the next turn starts anyway.
    setTimeout(() => {
      if (this.exiting.get(sessionId)?.turn !== turn) return;
      console.error(`@${se?.handle ?? sessionId}’s stopped turn hadn’t ended after ${STOP_WATCHDOG_MS / 1000} s, so its next turn starts anyway.`);
      this.turnExited(turn);
    }, STOP_WATCHDOG_MS).unref?.();
    // A stopped summary (or one queued behind the turn, which goes with it) isn’t coming (#93), in a topic thread too.
    // A message from another agent, waiting behind the turn, goes with it: it hears at its next turn what it said.
    this.clearSummaryPending(turn.threadId);
    for (const p of turn.pending) {
      if (p.summarizeTo && p.threadId) this.clearSummaryPending(p.threadId);
      // A shutdown leaves it due, for the restart to bring back (rearmWakes), as it does a scheduled turn of its own.
      if (by !== 'shutdown') dropScheduledWake(this, p.message);
      if (se) queue.rememberStoppedMessages(this, sessionId, p.message);
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
  /**
   * What every stop of a turn records, whoever stopped it: your Stop, a shutdown, or the store closing (server/store-outage.mjs).
   * One path, so no way of ending a turn skips a step (gpt’s finding on 1b: a scheduled turn the outage stopped stayed
   * running). A shutdown leaves a scheduled wake due for the restart (#466); every other stop ends it.
   * @param {any} turn @param {{ status: string, stoppedAt: number, stopReason: string | null }} ended
   * @param {{ by: string, why: string }} o  who, and what a waiting permission is told
   */
  recordStopped(turn, ended, { by, why }) {
    const { sessionId } = turn;
    // Your Stop ends a scheduled wake’s turn for good, so a restart doesn’t run it again; a shutdown leaves it due
    // (#466). A store outage leaves it too: the reload re-arms it as interrupted, its one owner (S1), so settling it
    // here as well would cancel what the agent was told will start again (the integrator’s re-review of #598).
    if (by !== 'shutdown' && by !== 'store') settleScheduledWake(this, turn, { name: 'AbortError' });
    settleStoppedSteps(this, turn);
    this.endWork(turn, 'stopped');
    // A waiting permission is answered no; the card keeps who stopped it, so its note says the person’s stop withdrew
    // it, or that it expired (tellExpired, #721, #853).
    for (const [id, w] of this.permissionWaits) if (w.sessionId === sessionId) this.settlePermission(id, 'expired', why, {}, { stoppedBy: by });
    // The open segment by its id, even while it is held behind a commit (its patch follows it in order); then any
    // other segment of this turn still streaming in the visible state (#602).
    let marked = false;
    if (turn.openSegment) {
      this.patchItem(turn.threadId, turn.openSegment, ended);
      marked = true;
    }
    for (const it of this.store.pending.items(turn.threadId)) {
      if (it.turnId === turn.id && it.kind === 'agent' && it.status === 'streaming' && it.id !== turn.openSegment) {
        this.patchItem(turn.threadId, it.id, ended);
        marked = true;
      }
    }
    turn.openSegment = null;
    // The reply always says it was stopped: with no segment still streaming, the stopped reply goes below the last
    // thing the turn showed (#602), on every path that records a stop, the store’s included.
    const se = this.s.sessions[sessionId];
    if (se && !marked)
      this.addItem(turn.threadId, {
        kind: 'agent',
        sessionId,
        personaId: se.personaId,
        handle: se.handle,
        turnId: turn.id,
        text: '',
        ...replyMarks(turn),
        ...ended,
      });
  }

  turnExited(turn) {
    // What the exit writes waits for writes to reopen (ST-3), behind the stop’s own records (server/store-outage.mjs).
    if (!this.store.writable) return whenWritable(this, () => this.turnExited(turn));
    this.settleJobs(turn);
    const ex = this.exiting.get(turn.sessionId);
    if (ex?.turn !== turn) return;
    this.exiting.delete(turn.sessionId);
    // From the pending session: Stop's “stopping” may still be held behind a commit as the turn exits (#796).
    const se = this.store.pending.session(turn.sessionId) ?? this.s.sessions[turn.sessionId];
    if (!se) return;
    // Something else may have set the state meanwhile (archive, an answered card); “Stopping” goes either way.
    // A remote turn Postbox stopped because it hung says so instead (#120).
    const hung = se.remoteTurn?.state === 'hung' && se.remoteTurn.rtTurn === turn.id;
    const stoppedBy = turn.stopReason === 'store' ? STORE_STOPPED : hung ? se.remoteTurn.message : 'Stopped by you';
    if (se.state === 'stopping' || se.currentStep === 'Stopping')
      this.updateSession(se.id, { state: se.state === 'stopping' ? 'idle' : se.state, currentStep: stoppedBy, finishedAt: Date.now(), sideTurn: null });
    else if (se.sideTurn) this.updateSession(se.id, { sideTurn: null });
    const held = se.archived || se.deleting ? [] : ex.held;
    // Shutting down: your messages wait in their thread’s queue, which a restart keeps, rather than starting a CLI.
    if (this.closing) {
      for (const h of held.filter((x) => x.message.kind === 'user')) {
        const q = { id: newId('q'), text: h.message.text ?? '', attachments: h.message.attachments ?? [], sessionIds: [se.id], at: Date.now(), seq: arrival() };
        updateThread(this, h.threadId ?? se.threadId, (t) => ({ queue: [...(t.queue ?? []), q] }));
      }
      return;
    }
    for (const h of ex.silent ? held : queue.batchPending(this, held, se.threadId))
      this.deliver(se.id, h.message, { summarizeTo: h.summarizeTo, threadId: h.threadId });
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
    // A remote turn’s jobs stop with it (#120), so there’s nothing to ask.
    const running = turn.remote ? [] : this.runningJobs(sessionId, turn.id);
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
      turn.keptAny = true;
      this.updateSession(se.id, { jobs: jobs.map((x) => (x.id === id ? { ...x, kept: true, pgid: groups[0].pgid, groups } : x)) });
      // Postbox couldn’t tell which of the turn’s processes was the job, so it kept them all (#164): say so.
      const unsure = groups.length > 1 ? keepUnsure(groups.length) : null;
      if (unsure) this.setJobStep(old, { detail: unsure });
      this.ledger.jobUpdate(old, { kept: true });
      // Its CLI is gone, so nothing would tell the agent: its next turn hears it’s still running, and why it ran on. Claude
      // Code, resumed, marks a background command it has no end for as stopped, and says so to the agent (#249).
      // A step that follows it reads as running on (#129): the agent leaves it running, rather than closing it as failed.
      this.tellAgent(
        se.id,
        `Your background job ${id} (\`${clipText(old.command, 200)}\`) is still running: ${turn.stopReason === 'send-now' ? 'a message sent with Send now ended your last turn, but not this job' : 'the person stopped your last turn and kept this job running'}. If your CLI says it was stopped, that’s only because the process that started it has ended: it wasn’t stopped.${unsure ? ` ${unsure}` : ''}${old.outputFile ? ` Its output is in ${old.outputFile}.` : ''} They can stop it from the conversation. If a progress step follows it, leave that step running while the job runs: when it ends, Postbox tells you on your next turn.`,
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
    // Pending, so a job ended or kept behind a held commit is seen (#957).
    const se = this.store.pending.session(sessionId);
    const job = se?.jobs?.find((j) => j.id === jobId);
    if (!se || !job) return;
    // Work says how it ended too: its turn may have ended thinking it was still running (#164).
    this.ledger.jobUpdate(job, { state, by });
    this.updateSession(sessionId, (s) => ({ jobs: (s.jobs ?? []).filter((j) => j.id !== jobId) }));
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
    const now = this.store.pending.session(sessionId);
    const held = now?.heldSteps;
    if ((job.kept || detail === KEEP_LOST) && held && !(now.jobs ?? []).some((j) => j.kept)) {
      this.updateSession(sessionId, { heldSteps: null });
      const problems = this.turns.has(sessionId) ? [] : this.stallSteps({ threadId: held.threadId }, this.store.pending.session(sessionId));
      if (problems.length)
        this.tellAgent(
          sessionId,
          `Your background job ${job.id} ended while progress steps were running:\n${problems.map((p) => `- Block “${p.scope.title ?? p.scope.id}” (id ${p.scope.id}): ${p.message}`).join('\n')}`,
        );
    }
  }

  settleSubagentSteps(turn) {
    return settleSubagentSteps(this, turn);
  }

  /** The keys (`item:step`) of a session’s progress steps running in a thread. */
  runningProgress(threadId, sessionId) {
    return this.store.pending
      .items(threadId)
      .filter((it) => it.kind === 'block' && it.valid && it.sessionId === sessionId && it.block.type === 'progress')
      .flatMap((it) => it.block.steps.filter((s) => s.state === 'running').map((s) => `${it.id}:${s.id}`));
  }

  /** Changes a job’s step: in its turn while that runs, else in the reply it’s on. */
  setJobStep(job, patch) {
    const live = this.turns.get(job.sessionId);
    const turn = live?.id === job.turnId ? live : null;
    const steps = turn ? turn.steps : this.store.pending.item(job.threadId, job.itemId)?.activity?.steps;
    if (!Array.isArray(steps)) return;
    const next = steps.map((st) => (st.id === job.toolUseId ? { ...st, ...patch } : st));
    if (turn) turn.steps = next;
    const step = job.itemId ? next.find((st) => st.id === job.toolUseId) : null;
    if (step) this.store.emit('item.patch', { threadId: job.threadId, id: job.itemId, activityStep: step });
  }

  /** Jobs nothing reported the end of went with their CLI (SIGKILL, or a crash), unless Postbox kept them running. */
  settleJobs(turn) {
    for (const j of [...(this.s.sessions[turn.sessionId]?.jobs ?? [])])
      if (j.turnId === turn.id && j.state === 'running' && !j.kept) this.endJob(turn.sessionId, j.id, 'stopped', turn.keepJobs.has(j.id) ? KEEP_LOST : null);
    // Keep running kept none of them after all (KEEP_LOST): its reply doesn’t say they kept running (#249). One that was
    // kept counts though it’s been stopped since, from its row.
    if (turn.stopReason !== 'kept-jobs' || turn.keptAny || this.s.sessions[turn.sessionId]?.jobs?.some((j) => j.turnId === turn.id && j.kept)) return;
    turn.stopReason = 'stop';
    for (const it of this.store.pending.items(turn.threadId))
      if (it.turnId === turn.id && it.stopReason === 'kept-jobs') this.patchItem(turn.threadId, it.id, { stopReason: 'stop' });
  }

  /** Context the agent reads at the start of its next turn, as a Postbox notice. */
  tellAgent(sessionId, text) {
    tellAgent(this, sessionId, text);
  }

  /** The kept jobs, everywhere. */
  keptJobs() {
    return keptJobs(this);
  }

  watchKept() {
    return watchKept(this);
  }
  pollKept() {
    return pollKept(this);
  }

  stopKeptJobs(sessionIds, why) {
    return stopKeptJobs(this, sessionIds, why);
  }

  /** A background job’s own Stop (#129): server/kept-jobs.mjs. On a host, the daemon stops a turn as a whole (#120). */
  async stopJob(sessionId, jobId) {
    const se = this.session(sessionId);
    const job = (se.jobs ?? []).find((j) => j.id === jobId);
    const turn = this.turns.get(sessionId);
    if (job && !job.kept && turn?.id === job.turnId && turn.remote) throw httpError(409, `A job on a host stops with its turn. Stop @${se.handle} to stop it.`);
    return stopJob(this, sessionId, jobId);
  }

  /**
   * When Postbox shuts down: every turn’s CLI runs in its own process group, and so do the jobs Postbox kept running,
   * so they’d outlive it. Each is stopped, jobs too, and this waits for the turns’ processes to exit, up to graceMs.
   * @param {{ graceMs?: number }} [opts]
   */
  async stopTurns({ graceMs = 4000 } = {}) {
    this.closing = true;
    // A turn on a remote host doesn’t need Postbox: it goes on there, and is attached again after the restart (#120).
    // A stop that fails is logged, and the others still happen: one turn’s failure mustn’t leave the other turns’ CLIs,
    // the hosts’ link or the kept jobs running.
    const failed = (what, e) => console.error(`Postbox couldn’t stop ${what} cleanly as it shut down: ${e.message}`);
    for (const [id, turn] of [...this.turns]) {
      if (turn.remote) continue;
      try {
        this.stop(id, { silent: true, by: 'shutdown' });
      } catch (e) {
        failed(`the turn of session ${id}`, e);
      }
    }
    try {
      this.remote.close();
    } catch (e) {
      failed('the hosts’ link', e);
    }
    await this.stopKeptJobs(Object.keys(this.s.sessions), 'Postbox stopped it as it shut down.').catch((e) => failed('the background jobs it kept running', e));
    /** @type {NodeJS.Timeout|undefined} */
    let timer;
    const late = new Promise((r) => {
      timer = setTimeout(r, graceMs);
    });
    await Promise.race([Promise.all([...this.exiting.values()].map((x) => x.turn.exited)), late]);
    clearTimeout(timer);
  }

  /**
   * At startup: turns that were running on a remote host are attached again, and replayed, once the host’s welcome
   * lists them; one it doesn’t is Interrupted (server/remote/turns.mjs). Call after expireStalePermissions.
   */
  restoreRemoteTurns() {
    this.remote.restore();
  }

  /**
   * Resume, after a remote turn stopped with Sign-in needed or Interrupted: a turn that starts with why the last one
   * stopped (#120, D2).
   * @param {string} sessionId
   */
  resumeRemote(sessionId) {
    const r = this.remote.resume(sessionId);
    if (!r.ok) throw httpError(409, r.message);
    return { ok: true };
  }

  /** After a restart, no background job Postbox knew of is its to track any more. */
  expireStaleJobs() {
    for (const se of Object.values(this.s.sessions))
      for (const j of se.jobs ?? [])
        this.endJob(se.id, j.id, 'stopped', 'Postbox restarted while it ran. If Postbox didn’t shut down cleanly, it may still be running.');
  }

  /** Retry a failed reply: sends the same message again, or a promise of that when it’s read back from the store first. */
  retry(threadId, itemId) {
    const it = this.store.item(threadId, itemId);
    if (it?.status !== 'failed') throw httpError(409, 'Only a failed reply can be retried.');
    // What it was asked (turn-marks.mjs): refused, with nothing sent, when it was kept and can’t be read back exactly.
    return askedAgain(this, threadId, it, (asked) => {
      this.patchItem(threadId, itemId, { status: 'retried' });
      // Only the cards that wait until answered can take the need: the failed turn's own asks would flash until the
      // retried turn starts, and that turn's end decides them.
      releaseNeed(this, this.s.sessions[it.sessionId], itemId, undefined, { turnIds: [] });
      this.deliver(it.sessionId, { ...asked.message, retry: true, woken: it.wokeOnFailure ?? [] }, { summarizeTo: asked.summarizeTo, threadId });
    });
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
    return startTopic(this, threadId, itemId);
  }

  shareToConversation(topicId, itemId) {
    return shareToConversation(this, topicId, itemId);
  }
  summarizeBack(topicId, opts) {
    return summarizeBack(this, topicId, opts);
  }
  summarizing(topicId) {
    return summarizing(this, topicId);
  }
  clearSummaryPending(topicId, ended) {
    return clearSummaryPending(this, topicId, ended);
  }
  shareText(threadId, opts) {
    return shareText(this, threadId, opts);
  }

  // ── Shared memory in a conversation ────────────────────────────────────────────────
  // Every agent in a conversation can read all of it. Each session keeps a marker of the last item it was given;
  // a delivery starts with what came after it, from you and from the other agents, and an agent joining later
  // gets the recent history the same way. read_conversation reads further back.

  /** The catch-up text for a session, or null, and moves its marker to the end of the conversation (server/catch-up.mjs). */
  catchUp(se, exclude = []) {
    return catchUp(this, se, exclude);
  }

  /** The message a topic thread started from, for an agent’s first turn there (item-lines.mjs). */
  topicRootLine(se, t) {
    return topicRootLine(this, se, t);
  }

  /**
   * One conversation item as a line an agent can read, from the point of view of `se` (item-lines.mjs).
   * @param {any} i @param {any} [se] @param {number} [n] @param {any} [reader]  the session its attachments are for
   */
  describeItem(i, se = null, n = READING.item, reader = se) {
    return describeItem(this, i, se, n, reader);
  }

  /**
   * read_conversation: the conversation’s items, newest last, as text, each with its id (for read_message and react). thread: another thread of the same conversation
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
    const lines = slice.flatMap((i) => (this.readLine(i, se) ? [`[${i.id}] ${this.readLine(i, se)}`] : []));
    const before = end - slice.length;
    return `${lines.join('\n\n') || 'The conversation is empty.'}${before ? `\n\n(${before} earlier ${before === 1 ? 'item' : 'items'}; call again with skip: ${items.length - before} to read them.)` : ''}`;
  }

  /**
   * An item as read_conversation and read_message give it to `se`, whose own messages say “You”.
   * @param {any} i @param {any} se @param {number} [n]
   */
  readLine(i, se, n = READING.item) {
    return i.sessionId === se.id && i.kind === 'agent' ? `You (@${se.handle}): ${clipItem(i.text, n, i.id)}` : this.describeItem(i, null, n, se);
  }

  readMessage(se, args = {}) {
    return readMessage(this, se, args);
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

  /** A thread, then the conversation it branched from, following parentId (a topic or side thread’s is one level), as `thread` reads one. */
  lineage(threadId, thread = (/** @type {string} */ id) => this.s.threads[id]) {
    const out = [];
    for (let id = threadId; id && thread(id) && !out.includes(id) && out.length < 8; id = thread(id).parentId) out.push(id);
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
    const items = lineage.flatMap((id) => this.store.pending.items(id));
    const apps = Object.values(this.store.pending.apps()).filter((a) => lineage.includes(a.threadId));
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
    const own = this.store.pending.items(turn.threadId);
    const shown = own.filter((it) => it.kind === 'block' && it.valid && it.turnId === turn.id).map((it) => it.block.type);
    problems.push(...blockProblems(turn.said, shown, own.findLast((it) => it.kind === 'user')?.text ?? ''));
    return problems;
  }

  /**
   * A turn that was stopped or failed starts no lint turn, but its progress steps still running show as stalled, as
   * at a normal end (#58), and the agent hears which at the start of its next turn (#98).
   * @param {any} turn @param {any} se @param {'stopped' | 'failed' | 'shutdown' | 'hung'} how
   */
  stallLeftRunning(turn, se, how) {
    const problems = this.stallSteps(turn, se);
    if (!problems.length) return;
    const blocks = problems.map((p) => `- Block “${p.scope.title ?? p.scope.id}” (id ${p.scope.id}): ${p.message}`);
    this.tellAgent(
      se.id,
      `${{ stopped: 'The person stopped your last turn', failed: 'Your last turn failed', shutdown: 'Postbox shut down during your last turn', hung: 'Postbox stopped your last turn, which had no output for too long,' }[how]} while progress steps were running:\n${blocks.join('\n')}`,
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
    for (const it of this.store.pending.items(turn.threadId)) {
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
    return sendLint(this, turnId);
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
    // Its own place in the turn (formatMessage, server/adapters/guide.mjs): after the request, before the background.
    return problems.length ? { ...message, lint: formatLint(lintMessage(problems), { folded: true }) } : message;
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

  // ── Permission prompts: server/permission-cards.mjs ──────────────────────────────────

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

  // ── The permissions panel (#66): server/permissions-panel.mjs ─────────────────────

  panelTarget(who) {
    return panelTarget(this, who);
  }
  latestProject(personaId) {
    return latestProject(this, personaId);
  }
  permissionsView(who) {
    return permissionsView(this, who);
  }
  changePermissionRule(change) {
    return changePermissionRule(this, change);
  }
  changePermissionFolder(change) {
    return changePermissionFolder(this, change);
  }
  setPermissionMode(personaId, mode) {
    return setPermissionMode(this, personaId, mode);
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
    updateThread(this, threadId, { hops: 0 });
    if (this.sessionsIn(threadId).length > 1) this.addItem(threadId, { kind: 'system', variant: 'wake', from: 'you', to: se.handle });
    this.deliver(se.id, { kind: 'user', text: line, attachments: [], itemId: item.id, slash: true });
    return { item };
  }

  /** Changes the model or the effort a conversation runs with (/model, /effort): server/session-run.mjs. */
  setSessionRun(sessionId, change) {
    return setSessionRun(this, sessionId, change);
  }

  /**
   * The folder a conversation’s `!` commands run in: where the agent that replies there works, as its adapter decides
   * (its own folder, the project’s, or a workspace of its own), else the project’s.
   * `!` runs on this computer even when that agent runs on a host (#67, #120): then it’s the project’s folder here,
   * else the workspace of its own the agent would have here, never a path on the host, and `host` names the host.
   * @param {string} threadId @returns {Promise<{ folder: string|null, host: string|null }>}
   */
  async commandFolder(threadId) {
    const t = this.thread(threadId);
    const members = this.sessionsIn(threadId).filter((x) => !x.archived);
    const se = members.find((x) => x.id === t.lastSpeaker) ?? members[0];
    const persona = se ? this.personaFor(se) : null;
    const project = this.s.projects[t.projectId] ?? null;
    const adapter = persona ? requestAdapter(this, se.handle, persona) : null;
    if (persona?.remote?.hostId) return hereFolder(this, persona, project, adapter);
    return { folder: await workFolder(adapter, persona, project), host: null };
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
    const { folder: cwd, host } = await this.commandFolder(threadId);
    if (!cwd) throw httpError(409, 'This conversation has no folder to run commands in. Give the project or the agent a folder first.');
    // Said once, as the output’s first line, when the agent here runs on a host: you, and the agents, see where it ran.
    const note = host ? `! commands run on this computer, not on ${host}.\n` : '';
    const startedAt = Date.now();
    const it = this.addItem(threadId, {
      kind: 'command',
      command: line,
      cwd,
      ...(host ? { notOn: host } : {}),
      status: 'running',
      text: note,
      cut: false,
      exitCode: null,
      signal: null,
      startedAt,
    });
    let out = note; // the end of the output so far, at most twice the bound between flushes
    let sent = note.length; // characters already sent as item.text, before the output was cut
    let cut = false;
    let refreshed = 0; // refreshes of the item’s text since it was cut
    let refreshedAt = 0;
    /** @type {NodeJS.Timeout|null} */
    let timer = null;
    const flush = ({ final = false } = {}) => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (!this.store.pending.item(threadId, it.id)) return;
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
        // How it ended is written once writes are open: the output chunks are memory-only while closed (I1), but a
        // status left “running” in the recovered state would never end.
        whenWritable(this, () => {
          if (!this.store.pending.item(threadId, it.id)) return;
          this.patchItem(threadId, it.id, {
            status: run.stopped ? 'stopped' : error ? 'failed' : code === 0 ? 'done' : 'failed',
            exitCode: typeof code === 'number' ? code : null,
            signal: signal ?? null,
            ms: Date.now() - startedAt,
            ...(cut ? { paused: false } : {}),
            ...(run.closing ? { error: 'Postbox stopped it as it shut down.' } : error ? { error: clipText(String(error.message ?? error), 300) } : {}),
          });
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
    if (!runsHere(this, 'claude-code')) throw httpError(422, 'Claude Code isn’t available on this computer, so its sessions can’t be attached.');
    const cs = (await listClaudeSessions({ root: this.config.claudeProjectsRoot, limit: 500 })).find((x) => x.id === claudeSessionId);
    if (!cs) throw httpError(404, 'That Claude Code session wasn’t found. It may have been deleted.');
    if (!cs.cwd) throw httpError(422, 'That session doesn’t say which folder it ran in, so Postbox can’t resume it.');
    const folder = sessionFolder(cs.cwd);
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
    for (let n = 2; this.personaByHandle(name) || this.deletingHandle(name); n++) name = `${base.slice(0, 20)}-${n}`;
    const p = this.createPersona({
      handle: name,
      backend: 'claude-code',
      description: `Attached from Claude Code in ${cs.cwd}`,
      folder,
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
    // While the store is closed the tail isn’t advanced: what was typed waits in the file and is read after Retry,
    // instead of into memory only, where the reload would discard it (the integrator’s finding on 1b).
    if (!this.store.writable) return;
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
        for (const b of contentBlocks(e.message?.content)) {
          if (b.type === 'text' && b.text?.trim()) {
            const it = m.agentItem && this.store.pending.item(se.threadId, m.agentItem);
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

  /**
   * The model a persona of this backend gets when it names none: the mock’s, else Claude’s default, unless the backend
   * offers AUTO_MODEL and not Claude’s default. That’s Codex, which runs none of Claude’s models and always offers
   * AUTO_MODEL, alone when its CLI gave no list (Codex only on a host, #120): Claude’s default would fail its turn. Kiro
   * runs Claude’s models, listed or not, and the Antigravity CLI puts its own default in place of Claude’s.
   * @param {string} backend
   */
  defaultModelFor(backend) {
    if (backend === 'mock') return 'mock';
    const offered = registeredAdapter(this, { backend })?.capabilities?.models ?? null;
    return offered?.includes(AUTO_MODEL) && !offered.includes(DEFAULT_MODEL) ? AUTO_MODEL : DEFAULT_MODEL;
  }

  createPersona({
    handle,
    description = '',
    instructions = '',
    backend = 'mock',
    model = this.defaultModelFor(backend),
    effort = DEFAULT_EFFORT,
    permissionMode = 'auto',
    usesHostSetup = true,
    canPublish = false,
    mcpOff = [],
    skillsOff = [],
    folder = '',
    tools = [],
    examples = [],
    createdBy = null,
    remote = null,
  }) {
    handle = handleOf(handle);
    if (this.personaByHandle(handle)) throw httpError(409, `@${handle} already exists. Pick another name.`);
    if (this.deletingHandle(handle)) throw httpError(409, `@${handle} is being deleted. Undo that, or wait 10 seconds for the name to be free.`);
    if (!this.adapters.names().includes(backend)) throw httpError(422, notHere(this, backend));
    if (!PERMISSION_MODES.includes(permissionMode)) throw httpError(422, `Permissions are one of ${PERMISSION_MODES.join(', ')}.`);
    checkEffort(effort);
    checkSetup({ usesHostSetup, canPublish, mcpOff, skillsOff });
    const placed = placement(this, remote, backend);
    if (!placed && !runsHere(this, backend)) throw httpError(422, notHere(this, backend));
    const p = {
      id: newId('pe'),
      handle,
      description,
      instructions,
      model: String(model || this.defaultModelFor(backend)),
      effort,
      backend,
      permissionMode,
      usesHostSetup,
      canPublish,
      mcpOff: serverNames(mcpOff),
      skillsOff: skillNames(skillsOff),
      folder: placedFolder(folder, placed),
      tools: [...new Set(tools)],
      examples,
      createdBy,
      remote: placed,
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
    if (patch.skillsOff !== undefined) patch = { ...patch, skillsOff: skillNames(patch.skillsOff) };
    if (patch.backend !== undefined && !this.adapters.names().includes(patch.backend)) throw httpError(422, notHere(this, patch.backend));
    // Where it runs (#120), and whether its backend runs here when that’s here.
    patch = placedPatch(this, id, p, patch);
    // Its folder is checked for where it runs once the change is made (#990).
    if (patch.folder !== undefined) patch = { ...patch, folder: placedFolder(patch.folder, patch.remote === undefined ? p.remote : patch.remote) };
    // A persona moved from the mock to a real model gets that backend’s default model.
    if (patch.backend && patch.backend !== 'mock' && (patch.model ?? p.model) === 'mock') patch = { ...patch, model: this.defaultModelFor(patch.backend) };
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
        'allowRequested',
        'mcpOff',
        'skillsOff',
        'folder',
        'tools',
        'examples',
        'retired',
        'remote',
      ]),
      version: (p.version ?? 1) + 1,
    };
    this.store.emit('persona', next);
    // A card that asked for a tool now on answers itself, wherever it was turned on (#237).
    if (patch.tools !== undefined) settleToolAsks(this, next);
    return next;
  }

  // ── Remote hosts (#120): server/remote/placement.mjs, host-admin.mjs and host-status.mjs ──────────

  localBackends() {
    return localBackends(this);
  }

  host(id) {
    return host(this, id);
  }

  addHost(opts) {
    return addHost(this, opts);
  }

  updateHost(id, patch) {
    return updateHost(this, id, patch);
  }

  removeHost(id, opts) {
    return removeHost(this, id, opts);
  }

  hostStatus(id) {
    return hostStatus(this, id);
  }

  watchHosts() {
    return watchHosts(this);
  }

  describeHostInstall(id) {
    return describeHostInstall(this, id);
  }

  installHost(id) {
    return installHost(this, id);
  }

  retryHost(id, opts) {
    return retryHost(this, id, opts);
  }

  setProjectHostFolder(projectId, hostId, folder) {
    return setProjectHostFolder(this, projectId, hostId, folder);
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
    const folder = folderOrNone(persona) || project?.folder || null;
    // An init from another folder says nothing about that folder’s project and local servers here: keep only the
    // ones that load everywhere (user, claude.ai, plugins).
    const seenFolder = seen && (folderOrNone(this.persona(seen.personaId)) || this.s.projects[this.s.threads[seen.threadId]?.projectId]?.folder || null);
    const servers = seen?.mcpServers.servers ?? [];
    return {
      persona,
      folder,
      seen: seenFolder === folder ? servers : servers.filter((s) => s.source !== 'project' && s.source !== 'local'),
      // The skills that session listed in its / menu (#207): the sheet takes only plugins’, which load in every folder.
      skills: (seen?.commands ?? []).filter((c) => c.skill).map((c) => c.name),
    };
  }

  // ── Session lifecycle: archive, restore, delete with undo ─────────────────────────

  archive(sessionId) {
    this.stop(sessionId, { silent: true });
    // A turn on a host waiting to be attached again after a restart, or to resume, isn’t attached or resumed (#120).
    this.remote.cancel(sessionId);
    const se = this.session(sessionId);
    this.updateSession(sessionId, { archived: true, state: 'idle', needs: null, archivedAt: Date.now() });
    dropWakes(this, se, 'archived');
    if (this.sessionsIn(se.threadId).every((x) => x.id === sessionId || x.archived)) updateThread(this, se.threadId, { archived: true });
  }

  restore(sessionId) {
    const se = this.session(sessionId);
    if (se.retiredFork) throw httpError(409, 'A fork from before agents had one session per conversation can’t come back: its agent answers there now.');
    this.updateSession(sessionId, { archived: false, archivedAt: null });
    updateThread(this, se.threadId, (t) => (t.archived ? { archived: false } : null));
  }

  /**
   * A conversation or room and every thread under it, a side thread a topic thread’s fork woke included: what
   * archiving, restoring or deleting it covers (#101, #320).
   */
  archiveScope(threadId) {
    const t = this.thread(threadId);
    if (t.kind === 'topic' || t.kind === 'side') throw httpError(409, 'Archive the conversation it belongs to instead.');
    return [t, ...Object.values(this.s.threads).filter((x) => x.id !== t.id && this.lineage(x.id).at(-1) === t.id)];
  }

  /**
   * Archives a conversation (#101): every session in it, its side and topic threads’ forks too, through archive(),
   * so each keeps its transcript and its backend session for Restore. It leaves the rail. A session is archived only
   * this way, with its conversation (#320): archive() has no route of its own.
   */
  archiveThread(threadId) {
    const threads = this.archiveScope(threadId);
    const ids = threads
      .flatMap((t) => this.sessionsIn(t.id))
      .filter((se) => !se.archived)
      .map((se) => se.id);
    for (const id of ids) this.archive(id);
    for (const t of threads) updateThread(this, t.id, (x) => (x.archived ? null : { archived: true }));
    // What it archived: every agent here that wasn’t yet.
    return ids;
  }

  /** Restores every archived session in a conversation and its side and topic threads, and the threads with them. */
  restoreThread(threadId) {
    const threads = this.archiveScope(threadId);
    // A fork retired by #228’s migration stays archived.
    for (const t of threads) for (const se of this.sessionsIn(t.id)) if (se.archived && !se.retiredFork) this.restore(se.id);
    for (const t of threads) updateThread(this, t.id, (x) => (x.archived ? { archived: false } : null));
  }

  /** Deletes after DELETE_UNDO_MS unless undone. The persona always stays. */
  deleteSession(sessionId) {
    this.stop(sessionId, { silent: true });
    // A turn of one on a host, waiting to be attached again or to resume, is neither, as deleting a conversation does.
    this.remote.cancel(sessionId);
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
    // A turn of one on a host, waiting to be attached again or to resume, is neither (#120).
    for (const x of this.archiveScope(threadId))
      for (const se of this.sessionsIn(x.id)) {
        this.stop(se.id, { silent: true });
        this.remote.cancel(se.id);
      }
    updateThread(this, threadId, { deleting: until });
    clearTimeout(this.timers.get(`delt:${threadId}`));
    this.timers.set(`delt:${threadId}`, setTimeout(() => this.purgeThread(threadId), DELETE_UNDO_MS).unref());
    return { until, title: t.title };
  }

  undoDeleteThread(threadId) {
    clearTimeout(this.timers.get(`delt:${threadId}`));
    this.timers.delete(`delt:${threadId}`);
    updateThread(this, threadId, { deleting: null }); // a thread that doesn’t exist: archiveScope answers 404
    // Its stopped turns skipped the drain (a silent stop): what its queues held goes now, as after a session’s Undo.
    for (const x of this.archiveScope(threadId)) this.drainQueue(x.id);
    // …and what reached its agents in the window (deliver held it), in the order it came (#725).
    for (const x of this.archiveScope(threadId)) for (const se of this.sessionsIn(x.id)) releaseHeld(this, se.id);
  }

  purgeThread(threadId) {
    this.timers.delete(`delt:${threadId}`);
    // Nothing durable can happen while writes are closed: the purge waits for them to reopen (and Retry re-arms it
    // from the recovered state too; a second run finds nothing deleting). See gated() in store-outage.mjs.
    if (!this.store.writable) return whenWritable(this, () => this.purgeThread(threadId), { owner: `delt:${threadId}` });
    const t = this.s.threads[threadId];
    if (!t?.deleting) return;
    // Everything under it, a side thread of a topic thread too, and their sessions with them (#320).
    eraseThreads(
      this,
      this.archiveScope(threadId).map((x) => x.id),
      'Its conversation was deleted.',
    );
  }

  stopMirrorFor(sessionId) {
    const m = this.mirrors.get(sessionId);
    if (m) clearInterval(m.timer);
    this.mirrors.delete(sessionId);
  }

  renameThread(threadId, title) {
    this.thread(threadId);
    const name = String(title ?? '')
      .trim()
      .slice(0, 120);
    if (!name) throw httpError(422, 'A conversation needs a name.');
    return updateThread(this, threadId, { title: name });
  }

  undoDelete(sessionId) {
    const se = this.session(sessionId);
    // Its persona’s delete would take it again (persona-delete.mjs): Undo that instead.
    if (this.s.personas[se.personaId]?.deleting) throw httpError(409, `@${se.handle} is being deleted. Undo that first.`);
    clearTimeout(this.timers.get(`del:${sessionId}`));
    this.timers.delete(`del:${sessionId}`);
    this.updateSession(sessionId, { deleting: null });
    // What the drain held back while it was being deleted goes now (#427, R1): Undo releases a hold, so it drains.
    // From its conversation: a retired fork’s session lives in a topic, where archiveScope refuses (#597 review).
    const conv = this.lineage(se.threadId).at(-1);
    if (this.s.threads[conv]) for (const x of this.archiveScope(conv)) this.drainQueue(x.id);
    // …and what reached it while it was being deleted (deliver held it), in the order it came.
    releaseHeld(this, sessionId);
  }

  purgeSession(sessionId) {
    this.timers.delete(`del:${sessionId}`);
    if (!this.store.writable) return whenWritable(this, () => this.purgeSession(sessionId), { owner: `del:${sessionId}` }); // as purgeThread
    const se = this.s.sessions[sessionId];
    discardHeld(this, sessionId, se?.deleting ? 'was deleted' : 'had a stale purge');
    if (!se?.deleting) return;
    // A turn it still has would run on for a session that’s gone: stop it first (#597 review).
    if (this.turns.has(sessionId)) this.stop(sessionId, { silent: true });
    // The person’s messages queued for it leave the queue now, not at delete, so Undo found them untouched (#427).
    queue.releaseQueued(this, sessionId);
    // Background jobs Postbox kept running for it would run on with no record (#129).
    this.stopKeptJobs([sessionId], 'Its session was deleted.').catch((e) => console.error(`Couldn’t stop a deleted session’s jobs: ${e.message}`));
    const t = this.store.pending.thread(se.threadId); // a member that joined behind a held commit keeps its room (#796)
    const others = (t?.members ?? []).filter((id) => id !== sessionId && this.store.pending.session(id));
    if (t && !others.length) {
      // Its own conversation goes with it, as deleting the conversation does: every thread under it, with its sessions
      // and apps (#320).
      eraseThreads(this, t.kind === 'topic' || t.kind === 'side' ? [t.id] : this.archiveScope(t.id).map((x) => x.id), 'Its session was deleted.', [sessionId]);
    } else if (t) {
      // In a room: it leaves, and its past messages stay, marked deleted.
      const gone = t.members.filter((id) => !others.includes(id)); // it, and any member whose session is gone; a held join stays
      updateThread(this, t.id, (x) => ({
        members: x.members.filter((id) => !gone.includes(id)),
        lastSpeaker: x.lastSpeaker === sessionId ? (others[0] ?? null) : x.lastSpeaker,
      }));
      for (const it of this.store.pending.items(t.id)) if (it.sessionId === sessionId) this.patchItem(t.id, it.id, { deletedAgent: true });
      this.addItem(t.id, { kind: 'system', variant: 'left', to: se.handle });
    }
    if (this.s.sessions[sessionId]) this.store.emit('remove', { kind: 'session', id: sessionId });
  }

  // ── Scheduled wake-ups ─────────────────────────────────────────────────────────────

  schedule(sessionId, options) {
    return scheduleWake(this, sessionId, options);
  }

  arm(sc) {
    return armWake(this, sc);
  }

  cancelSchedule(scheduleId) {
    return cancelWakeSchedule(this, scheduleId);
  }

  rearmSchedules() {
    return rearmWakes(this);
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

  addDataset(sessionId, args) {
    return addDataset(this, sessionId, args);
  }
  reloadDatasets() {
    return reloadDatasets(this);
  }

  // ── Presence ───────────────────────────────────────────────────────────────────────

  view(threadId) {
    if (!threadId) return;
    this.viewing.set(threadId, Date.now());
    // Each read pending, as the thread's next: an unread a turn's end counted behind a held commit is cleared too (#796).
    for (const se of pendingSessionsIn(this, threadId)) if (se.unread) this.updateSession(se.id, { unread: 0 });
    updateThread(this, threadId, (t) => (t.unread ? { unread: 0 } : null));
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
    return recordedTools(rt, turn, {
      /** @param {{ block: any }} args @param {{ files?: AppFile[] }} [given]  data files Postbox read for show_app (#54) */
      show_block(args, given = {}) {
        return showBlock(rt, sessionId, { turn, se, threadId, endSegment, tools: this }, args, given);
      },
      update_block(args, given = {}) {
        return updateBlock(rt, sessionId, args, { turn, se, threadId, endSegment }, given);
      },
      review_block: (args) => reviewBlock(rt, sessionId, args),
      show_app(args, given = {}) {
        return showApp(rt, sessionId, this, args, given);
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
          // Its turn’s, so it shares that turn’s sender line and no other (#135).
          turnId: turn?.id ?? null,
          ...wokeOf(turn),
          status: 'open',
          proposal: { handle: String(handle).replace(/^@/, ''), description, instructions, tools, model, backend },
          extraTools: tools.filter((t) => !mine.has(t)),
        });
        return { ok: true, message: 'Proposed. The person decides whether to create it.' };
      },
      schedule_wake({ in_minutes, note }) {
        const sc = rt.schedule(sessionId, { inMs: Math.round((+in_minutes || 1) * 60000), note });
        return { ok: true, message: `You’ll be woken at ${new Date(sc.at).toISOString()}. Its id is ${sc.id}, for cancel_wake.` };
      },
      cancel_wake: (args) => cancelWake(rt, sessionId, args),
      wake_agent: (args) => wakeAgent(rt, sessionId, args),
      open_topic: (args) => openTopic(rt, sessionId, args),
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
    });
  }
}

/** What Postbox asks when you stop an agent whose background jobs are running (#129). */
export function stopAskText(handle, n) {
  return `@${handle} has ${n === 1 ? '1 background job' : `${n} background jobs`} running. Stop ${n === 1 ? 'it' : 'them'} too?`;
}
// Postbox never kills a job you kept (#164), but one with no process left under its agent couldn’t be kept either.
const KEEP_LOST = 'Postbox couldn’t find its process to keep it running: it may have ended with the agent, and Postbox can’t show it or stop it.';
/** What the person and the agent are told when Postbox couldn’t tell which of a turn’s processes a kept job was (#164). */
const keepUnsure = (n) => `Postbox couldn’t tell which of ${n} processes is this job, so it kept them all running; stopping the job stops them all.`;

/** An error the ledger raised with a status, as the API answers it. */
const asHttp = (e) => {
  throw e?.status ? httpError(e.status, e.message) : e;
};
const snapshotOf = (p) =>
  pick(p, ['description', 'instructions', 'model', 'effort', 'permissionMode', 'usesHostSetup', 'canPublish', 'mcpOff', 'folder', 'tools', 'version']);
// Commands in the composer (#67), bounded: an agent’s list for the / menu, a `!command`’s output (its last
// characters), how often that output reaches the browser, and how much of it the agents read.
const MAX_COMMANDS = 200;
const MAX_COMMAND_OUTPUT = 64 * 1024;
const COMMAND_FLUSH_MS = 100;
const COMMAND_REFRESH_MS = 5000;
const MAX_COMMAND_REFRESHES = 60;
/** Server names, trimmed and without repeats. Postbox’s own server can’t be turned off, so it’s dropped. */
const serverNames = (list) => [...new Set(list.map((n) => n.trim()))].filter((n) => n !== POSTBOX_SERVER);
const skillNames = (list) => [...new Set(list.map((n) => n.trim()))];
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));

export { formatDuration };
