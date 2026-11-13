// The runtime: threads, sessions and turns. It decides who replies, wakes agents, enforces the wake
// limit, queues messages sent mid-reply, handles Stop, tracks what "needs you", and implements the UI
// tools that agents call (over MCP, or in-process for the mock).

import { homedir } from 'node:os';
import { READING } from '../shared/limits.mjs';
import { formatDuration } from '../shared/text.mjs';
import { carriedList } from '../shared/work.mjs';
import { listProcesses } from './adapters/process-group.mjs';
import { recordCommands, runAgentCommand } from './agent-commands.mjs';
import { agentFile, agentFolders, appFiles } from './agent-files.mjs';
import { APP_HOLD_MAX, APP_SEND_LIMIT, APP_SEND_WINDOW_MS } from './app-send-limits.mjs';
import { appCheck, appEvent, appFile, appQuery, appState, needAppSend, registerApp, resolveAppSend } from './apps.mjs';
import { ArchivePasses } from './archive-runtime.mjs';
import { askQuestions, QUESTION_TOOL, questionBlocks } from './ask-question.mjs';
import { act, answerDelivered, unreadAnswer } from './blocks.mjs';
import { catchUp, moveMarkers } from './catch-up.mjs';
import { attachClaudeSession, claudeSessions, mirror, pollMirror, rearmMirrors, stopMirrorFor, stopMirrors } from './claude-mirror.mjs';
import { createThread, ensureSession, renameThread } from './conversations.mjs';
import { deliver, retry } from './deliver.mjs';
import { diagramCheck } from './diagram-check.mjs';
import { clipText, httpError } from './helpers.mjs';
import { describeItem, topicRootLine } from './item-lines.mjs';
import { endJob, expireStaleJobs, recordJob } from './job-records.mjs';
import { keptJobs, pollKept, stopJob, stopKeptJobs, watchKept } from './kept-jobs.mjs';
import { Ledger } from './ledger.mjs';
import { endLint, foldLint, lint, quietLint } from './lint-delivery.mjs';
import { wakeMentions } from './mention-wakes.mjs';
import { attachmentPath } from './message-attachments.mjs';
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
import { retireModes, runsAs } from './permission-modes.mjs';
import { changePermissionFolder, changePermissionRule, latestProject, PERMISSION_MODES, panelTarget, permissionsView } from './permissions-panel.mjs';
import { createPersona, updatePersona } from './persona-write.mjs';
import { readCapped } from './read-capped.mjs';
import { addReadFolder, readCardAlways } from './read-folders.mjs';
import { readConversation, readLine, readMessage } from './read-message.mjs';
import { addHost, host, removeHost, setProjectHostFolder, updateHost } from './remote/host-admin.mjs';
import { describeHostInstall, hostStatus, installHost, retryHost, watchHosts } from './remote/host-status.mjs';
import { Placement } from './remote/placement.mjs';
import { RemoteTurns } from './remote/turns.mjs';
import { Running } from './running.mjs';
import { armWake, cancelWakeSchedule, rearmWakes, scheduleWake } from './scheduled-wakes.mjs';
import { sendMessage, threadRefs } from './send-message.mjs';
import { deleteSession, deleteThread } from './session-lifecycle.mjs';
import { pendingSessionsIn, stampNeeds, tellAgent, updateSession } from './session-write.mjs';
import { mcpContext } from './setup-context.mjs';
import { clearSummaryPending, shareText, shareToConversation, summarizeBack, summarizing } from './share-back.mjs';
import { commandFolder, expireStaleCommands, flushShellOutput, runShellCommand, stopShellCommand, stopShellCommands } from './shell-runs.mjs';
import { agentWake, bumpSideLink, recordAgentMessage, resolveHop, sideSession } from './side-threads.mjs';
import { newId } from './store.mjs';
import { watchStore } from './store-outage.mjs';
import { conversationThreads, glossaryFor, lineage } from './thread-lineage.mjs';
import { updateThread } from './thread-write.mjs';
import { startTopic } from './topic-open.mjs';
import { checkTurn, stallLeftRunning, stallSteps } from './turn-checks.mjs';
import { settleSubagentSteps } from './turn-steps.mjs';
import { dismissStopAsk, recordStopped, requestStop, stop, stopTurns } from './turn-stop.mjs';
import { toolsFor } from './ui-tools.mjs';
import { unarchive } from './unarchive.mjs';
import { closeOrphanCards } from './wake-cards.mjs';
import { restoreWork, workDiff, workGit, workOutput } from './work-view.mjs';

export { AgentFileError } from './agent-files.mjs';
export { httpError } from './helpers.mjs';
export { HOP_LIMIT } from './side-threads.mjs';
export { PERMISSION_MODES, readCapped };

/** @typedef {import('./agent-files.mjs').AppFile} AppFile */

export class Runtime {
  /**
   * @param {{ store: import('./store.mjs').Store, adapters: import('./adapters/adapter.mjs').AdapterRegistry,
   *           config: { origin: string, imageOrigins: string[], archiveTurns?: boolean, claudeProjectsRoot?: string, versions?: any, lintSettleMs?: number, ledgerGraceMs?: number, home?: string, build?: { version?: string } },
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
  constructor({ store, adapters, config, blobs, narrator, spawnShell, signalProcess, listProcesses: list, ledger, hosts }) {
    this.store = store;
    // While the store can’t be written, no turn runs or starts, and what would write waits (ST-3, server/store-outage.mjs).
    /** @type {(() => void)[]} */
    this.storeWait = [];
    /** @type {Map<string, Record<string, any>>} a backend’s state saved meanwhile, per session, merged (saveBackendState) */
    this.backendWait = new Map();
    watchStore(this);
    this.adapters = adapters;
    this.config = config;
    // Where the person’s Claude Code user settings are read and written (#66); tests and checks pass a temp folder.
    this.home = config.home ?? homedir();
    // CLAUDE_CONFIG_DIR moves the user settings (permission-rules.mjs, settingsFiles); an injected home never reads it.
    const { claudeConfigDir } = /** @type {{ claudeConfigDir?: string|null }} */ (config);
    this.configDir = claudeConfigDir !== undefined ? claudeConfigDir : this.home === homedir() ? process.env.CLAUDE_CONFIG_DIR || null : null;
    this.blobs = blobs ?? null;
    this.narrator = narrator ?? null;
    // A permission card’s item id, or an AskUserQuestion block’s (`question`, server/ask-question.mjs) → its call’s wait.
    this.permissionWaits = new Map(); // item id → { resolve, threadId, sessionId, timer, question? }
    this.mirrors = new Map(); // attached session id → { tail, timer, agentItem, steps }
    // The live turn per session, the stopped ones still exiting (#126), the host turns waiting to be attached again
    // (#1135), and whether Postbox is shutting down (designs/architecture/services.md, “Running”).
    this.running = new Running();
    this.signalProcess = signalProcess ?? process.kill;
    this.listProcesses = list ?? listProcesses;
    /** @type {NodeJS.Timeout|null} */
    this.keptPoll = null; // checks on the background jobs Postbox kept running (#129)
    this.viewing = new Map(); // threadId → last time a browser said it was open
    this.timers = new Map(); // scheduleId → timeout
    this.watchdogs = new Set(); // stopped turns’ watchdogs, cleared by close (server/runtime-close.mjs)
    this.lints = new Map(); // agent turn id → its lint turn, gathering: { sessionId, kind, ended, sent, problems, timer }
    this.spawnShell = spawnShell ?? undefined;
    this.shellRuns = new Map(); // command item id → { stop, kill, done, flush, stopped, closing }
    // What each conversation’s agents changed, ran and published (#132).
    this.ledger = ledger ?? new Ledger({ store, blobs: this.blobs, home: this.home });
    // Turns of agents whose persona runs on a remote host (#120): server/remote/turns.mjs.
    this.hosts = hosts ?? null;
    // Where each agent runs (designs/architecture/services.md, “Placement”). Moving an agent waits for a turn running
    // or still exiting, not for a host turn waiting to be attached (#1135), so it reads Running’s midTurn, not busy.
    this.placement = new Placement({
      store,
      midTurn: (sessionId) => this.running.midTurn(sessionId),
      adapters,
      hosts: this.hosts,
    });
    this.remote = new RemoteTurns(this, { hosts: this.hosts });
    this.turnArchive = new ArchivePasses(this, { enabled: config.archiveTurns === true }); // #305: off until step 4
    // Conversations can’t be archived any more: one an older Postbox archived comes back as a live one.
    unarchive(this);
    // After that, so a card of an agent it brings back stays the person’s to answer (#693).
    closeOrphanCards(this);
    // Ask me and Accept edits are gone: a persona stored with one runs Auto (permission-modes.mjs).
    retireModes(this);
    // A need from before needsAt gets its item's time, once, so ⌃J orders it without the page holding its items.
    stampNeeds(this);
  }

  get s() {
    return this.store.state;
  }

  // Running’s maps and its closing flag, for the code that waits for rooms at scale and still reads them through the
  // runtime (designs/architecture/services.md, “Running”). Writes go through this.running.

  /** sessionId → live turn */
  get turns() {
    return this.running.turns;
  }

  /** sessionId → a stopped turn whose process hasn’t exited yet, and what waits for it: { turn, held, silent } (#126) */
  get exiting() {
    return this.running.exiting;
  }

  /** Postbox is shutting down: no new turn starts (#126). */
  get closing() {
    return this.running.closing;
  }

  // ── Lookups ────────────────────────────────────────────────────────────────────────

  persona(id) {
    return this.s.personas[id];
  }
  /**
   * The persona a session runs with: the persona as it is now. One rule for every setting: a turn takes the persona
   * when it starts (adapterContext, server/turn-context.mjs), so every change applies from the agent’s next turn, in
   * every conversation it’s in, and never to a turn already running.
   */
  personaFor(se) {
    const p = this.persona(se.personaId);
    return (
      p && {
        ...p,
        permissionMode: runsAs(p.permissionMode),
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
    return (this.s.threads[threadId]?.members ?? []).map((id) => this.s.sessions[id]).filter(Boolean);
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
      .filter((x) => !x.retiredFork && !seen.has(x.handle) && seen.add(x.handle))
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

  // ── A conversation’s own record: server/conversations.mjs ─────────────────────────

  createThread(opts) {
    return createThread(this, opts);
  }
  ensureSession(threadId, personaId, opts) {
    return ensureSession(this, threadId, personaId, opts);
  }
  renameThread(threadId, title) {
    return renameThread(this, threadId, title);
  }

  // ── Messages from you: server/send-message.mjs and message-queue.mjs ──────────────

  /** You send a message: @mentions wake agents (joining them to the thread); otherwise the last speaker replies. */
  sendMessage(threadId, message) {
    return sendMessage(this, threadId, message);
  }
  threadRefs(threadId, text) {
    return threadRefs(this, threadId, text);
  }

  postAndDeliver(threadId, { text, attachments }, targets) {
    return queue.postAndDeliver(this, threadId, { text, attachments }, targets);
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

  // ── Turns: server/deliver.mjs, turn-stop.mjs and job-records.mjs ────────────────────

  deliver(sessionId, message, opts) {
    return deliver(this, sessionId, message, opts);
  }
  retry(threadId, itemId) {
    return retry(this, threadId, itemId);
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

  // ── Stopping a turn: server/turn-stop.mjs ──────────────────────────────────────────

  stop(sessionId, opts) {
    return stop(this, sessionId, opts);
  }
  recordStopped(turn, ended, how) {
    return recordStopped(this, turn, ended, how);
  }
  requestStop(sessionId, choice) {
    return requestStop(this, sessionId, choice);
  }
  dismissStopAsk(sessionId) {
    return dismissStopAsk(this, sessionId);
  }
  stopTurns(opts) {
    return stopTurns(this, opts);
  }

  // ── Background jobs (#129): server/job-records.mjs and kept-jobs.mjs ───────────────

  recordJob(turn, j) {
    return recordJob(this, turn, j);
  }
  endJob(sessionId, jobId, state, detail, opts) {
    return endJob(this, sessionId, jobId, state, detail, opts);
  }
  expireStaleJobs() {
    return expireStaleJobs(this);
  }

  settleSubagentSteps(turn) {
    return settleSubagentSteps(this, turn);
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

  readConversation(se, args) {
    return readConversation(this, se, args);
  }
  readLine(i, se, n) {
    return readLine(this, i, se, n);
  }
  readMessage(se, args = {}) {
    return readMessage(this, se, args);
  }

  // ── A thread’s place in its conversation: server/thread-lineage.mjs ─────────────────

  conversationThreads(threadId) {
    return conversationThreads(this, threadId);
  }
  lineage(threadId, thread) {
    return lineage(this, threadId, thread);
  }
  glossaryFor(threadId) {
    return glossaryFor(this, threadId);
  }

  // ── The lint pipeline ──────────────────────────────────────────────────────────────
  // Every check returns problems, { code, message, scope } (server/checks.mjs). The problems an agent turn caused
  // go back to the agent as one lint turn: the server’s checks run when the turn ends, and the browser reports what
  // it measures (diagrams, the app check) as the reply renders, so the lint turn waits a moment for those. There’s
  // at most one lint turn per agent turn, a lint turn is never linted, and problems from a turn that failed or was
  // stopped are dropped.

  // The server’s checks over a finished turn: server/turn-checks.mjs.

  checkTurn(turn, se) {
    return checkTurn(this, turn, se);
  }
  stallLeftRunning(turn, se, how) {
    return stallLeftRunning(this, turn, se, how);
  }
  stallSteps(turn, se) {
    return stallSteps(this, turn, se);
  }

  // When checks reach an agent after its turn: server/lint-delivery.mjs.

  endLint(turn, problems) {
    return endLint(this, turn, problems);
  }
  lint(sessionId, turnId, problems) {
    return lint(this, sessionId, turnId, problems);
  }
  foldLint(sessionId, message) {
    return foldLint(this, sessionId, message);
  }
  quietLint(turn, se) {
    return quietLint(this, turn, se);
  }

  // Diagram checks from the page: server/diagram-check.mjs.

  diagramCheck(threadId, itemId, report) {
    return diagramCheck(this, threadId, itemId, report);
  }

  // ── Permission prompts: server/permission-cards.mjs ──────────────────────────────────

  requestPermission(sessionId, req) {
    // Claude Code’s AskUserQuestion asks as choice blocks, here on this computer: server/ask-question.mjs (#521).
    const questions = req.tool === QUESTION_TOOL && !req.hostPrompt ? questionBlocks(req.input) : null;
    return questions ? askQuestions(this, sessionId, req, questions) : requestPermission(this, sessionId, req);
  }
  askPerson(sessionId, req) {
    return askPerson(this, sessionId, req);
  }
  alwaysFor(se, req) {
    // A read outside an Antigravity agent’s folders offers its folder as readable (#338); otherwise as before.
    return readCardAlways(this, se, req) ?? alwaysFor(this, se, req);
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
    // A readable folder is saved for the conversation, then the card is answered as any Always allow (#338).
    if (it.always?.readDir && !it.remote) addReadFolder(this, it.sessionId, it.always.readDir);
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

  // ── Commands in the composer (#67): server/agent-commands.mjs and shell-runs.mjs ──────────
  // `/` runs Postbox’s own commands without a turn, or an agent’s skill or command as its turn; `!` runs a command line
  // as the person, in the conversation’s folder, and the agents read it on their next turn, without being woken.

  recordCommands(sessionId, list) {
    return recordCommands(this, sessionId, list);
  }
  runAgentCommand(threadId, req) {
    return runAgentCommand(this, threadId, req);
  }
  commandFolder(threadId) {
    return commandFolder(this, threadId);
  }
  runShellCommand(threadId, command) {
    return runShellCommand(this, threadId, command);
  }
  flushShellOutput() {
    return flushShellOutput(this);
  }
  stopShellCommand(threadId, itemId) {
    return stopShellCommand(this, threadId, itemId);
  }
  stopShellCommands(opts) {
    return stopShellCommands(this, opts);
  }
  expireStaleCommands() {
    return expireStaleCommands(this);
  }

  // ── The work ledger’s answers to the page (#132): server/work-view.mjs ─────────────

  workGit(threadId) {
    return workGit(this, threadId);
  }
  workDiff(threadId, fileId, changeId) {
    return workDiff(this, threadId, fileId, changeId);
  }
  workOutput(threadId, entryId) {
    return workOutput(this, threadId, entryId);
  }
  restoreWork(threadId, fileId) {
    return restoreWork(this, threadId, fileId);
  }

  /** Where an attachment can be read on disk (server/message-attachments.mjs). */
  attachmentPath(threadId, a) {
    return attachmentPath(this, threadId, a);
  }

  // ── Attached Claude Code sessions: server/claude-mirror.mjs ─────────────────────────

  claudeSessions() {
    return claudeSessions(this);
  }
  attachClaudeSession(req) {
    return attachClaudeSession(this, req);
  }
  mirror(sessionId) {
    return mirror(this, sessionId);
  }
  rearmMirrors() {
    return rearmMirrors(this);
  }
  stopMirrors() {
    return stopMirrors(this);
  }
  pollMirror(sessionId) {
    return pollMirror(this, sessionId);
  }
  stopMirrorFor(sessionId) {
    return stopMirrorFor(this, sessionId);
  }

  // ── Personas: server/persona-write.mjs ─────────────────────────────────────────────

  createPersona(spec) {
    return createPersona(this, spec);
  }
  updatePersona(id, patch) {
    return updatePersona(this, id, patch);
  }

  // ── Remote hosts (#120): server/remote/placement.mjs, host-admin.mjs and host-status.mjs ──────────

  localBackends() {
    return this.placement.localBackends();
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

  // What the persona sheet shows of a persona’s setup: server/setup-context.mjs.
  mcpContext(personaId, projectId) {
    return mcpContext(this, personaId, projectId);
  }

  // ── Session lifecycle: server/session-lifecycle.mjs ─────────────────────────────

  deleteSession(sessionId) {
    return deleteSession(this, sessionId);
  }
  deleteThread(threadId) {
    return deleteThread(this, threadId);
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

  // ── UI tools (the same set MCP exposes): server/ui-tools.mjs ──────────────────────

  /** @param {string} sessionId @param {any} [turn]  the turn the tools act for; null outside a turn */
  toolsFor(sessionId, turn = null) {
    return toolsFor(this, sessionId, turn);
  }
}

export { formatDuration };
