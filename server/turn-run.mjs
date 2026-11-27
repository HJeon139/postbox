// Starting an agent's turn: deliver waits behind a turn, an exit or a held commit, builds the turn's message and its
// record, marks the session at work, and runs the adapter; retry delivers a failed reply's message again. Moved from
// server/runtime.mjs (#1236); Runtime keeps a method of each name, and each function here takes the runtime first.

import { randomUUID } from 'node:crypto';
import { attachedFiles } from './adapters/attached-files.mjs';
import { workFolder } from './adapters/folder.mjs';
import { toolsDownNote } from './adapters/tools-down.mjs';
import { heldSession } from './held-session.mjs';
import { httpError, retiredError } from './helpers.mjs';
import { refuseUnregistered } from './remote/placement.mjs';
import { clockTurn } from './run-clock.mjs';
import { holdForClock, refuseWhileHeld } from './run-clock-held.mjs';
import { prepareScheduledRetry } from './scheduled-wakes.mjs';
import { endChain } from './side-threads.mjs';
import { newId } from './store.mjs';
import { heldTurn, saveBackendState } from './store-outage.mjs';
import { whenWritable } from './store-wait.mjs';
import { notUrgent } from './subagent-end.mjs';
import { firstPromptSection } from './thread-catch-up.mjs';
import { arrival } from './turn-batch.mjs';
import { adapterContext } from './turn-context.mjs';
import { endTurn } from './turn-finish.mjs';
import { askedAgain } from './turn-marks.mjs';
import { turnExited } from './turn-stop.mjs';
import { inputOf, withEntries } from './turns.mjs';

/**
 * Runs one agent turn through its adapter.
 * threadId: where the turn speaks, when that isn’t the session’s own thread: a conversation session answers in a side
 * thread (#110), so one persona has one memory per conversation.
 * @param {any} rt  the runtime
 * @param {string} sessionId @param {any} message
 * @param {{ summarizeTo?: string|null, threadId?: string|null }} [opts]
 */
export function deliver(rt, sessionId, message, { summarizeTo = null, threadId = null } = {}) {
  // A session just made behind a held commit: its turn starts once it's published (#796's class in sessions).
  if (heldSession(rt, sessionId, () => rt.turnService.run(sessionId, message, { summarizeTo, threadId }))) return;
  const se = rt.store.pending.session(sessionId) ?? rt.session(sessionId); // a summary's or a notice's write held (#506)
  if (se.retiredFork) throw retiredError(se);
  // With run clocks on (server/run-clock-install.mjs), a paused or expired clock starts no turn of its agent, and what
  // came another way than its inbox waits for the resume (server/run-clock.mjs). A host turn attached again after a
  // restart starts, to be stopped once its remote turn is made (runTurn): it may be working on its host.
  const held = rt.runClock?.holds(sessionId) ?? false;
  if (held && typeof message.attach !== 'string') return holdForClock(rt, sessionId, { message, summarizeTo, threadId });
  message = prepareScheduledRetry(rt, message, se.threadId);
  // As it was asked, for Retry (askedOf).
  const asked = { message, summarizeTo, threadId };
  // The store can’t be written: the turn starts once it can (ST-3).
  if (heldTurn(rt, sessionId, () => rt.turnService.run(sessionId, asked.message, { summarizeTo, threadId }), message)) return;
  if (waitsBehind(rt, sessionId, message, { summarizeTo, threadId })) return;
  const where = threadId && threadId !== se.threadId && rt.store.pending.thread(threadId) ? threadId : se.threadId;
  rt.apps.answerDelivered(where, message);
  // A skill or command (#67) is the whole prompt, since Claude Code runs it only when the prompt starts with /name:
  // the context below waits for the agent’s next turn instead. So does a remote turn attached again after a restart
  // (#120, message.attach): it sends the agent nothing, and replays what the host has.
  const slash = message.slash === true || typeof message.attach === 'string';
  // The agent’s waiting entries in this thread come with it (turns.mjs), and Retry sends them again with it.
  if (!slash && !summarizeTo) asked.message = message = withEntries(rt, sessionId, where, message);
  // Postbox’s own marks (the turn’s chosen id, and how it takes entries) stay with Postbox, not the agent’s message.
  const { turnId, fromEntries: _taken, entriesWait: _waits, ...asSent } = message;
  // What the agent is sent, and the tools-down note it took, which a failed turn gives back (tools-down.mjs, #1171).
  const { toolsDownTaken, ...built } = turnMessage(rt, se, asSent, where, slash);
  message = built;
  const persona = rt.persona(se.personaId);
  const adapter = rt.placement.registeredAdapter(persona);
  const turn = newTurn(se, { ...message, turnId }, persona, { where, slash, summarizeTo, asked });
  if (held) turn.clockStops = true;
  turn.toolsDownTaken = toolsDownTaken ?? null;
  rt.running.begin(turn);
  // A persona on a remote host (#120): the turn is remote from here on (server/remote/turns.mjs).
  const hostId = adapter ? rt.placement.hostOf(persona) : null;
  if (hostId) rt.remote.begin(turn, hostId, adapter);
  else rt.remote?.leaveMoved(se.id);
  // The work ledger (#132) follows the turn’s tool calls. A change outside the project’s folder and the agent’s is
  // flagged; the adapter knows the agent’s folder. A remote agent’s folder is on its host, never made here.
  const project = rt.s.projects[rt.s.threads[se.threadId]?.projectId] ?? null;
  rt.ledger.startTurn(turn, {
    se,
    folder: hostId ? null : workFolder(adapter, persona, project),
    projectFolder: project?.folder ?? null,
  });
  atWork(rt, se, turn);
  runTurn(rt, se, turn, rt.runClock ? clockTurn(rt, se.id, turn.id, message) : message, { adapter, persona, hostId });
}

/**
 * A turn already running, or a stopped one still exiting, takes the message to start after it; while Postbox shuts
 * down, none starts. True when the message waits, or goes nowhere, instead of starting a turn now.
 * @param {any} rt @param {string} sessionId @param {any} message
 * @param {{ summarizeTo: string|null, threadId: string|null }} opts
 */
function waitsBehind(rt, sessionId, message, { summarizeTo, threadId }) {
  if (rt.turns.has(sessionId)) {
    // Agent-to-agent messages and events wait for the current turn to end.
    const t = rt.turns.get(sessionId);
    t.pending.push({ message: { ...message, at: message.at ?? Date.now(), seq: message.seq ?? arrival() }, summarizeTo, threadId });
    return true;
  }
  // A stopped turn’s process is still exiting: the next turn waits for it, so a session never runs two (#126). An answer
  // held here isn’t read yet: it’s read when the turn it starts begins.
  const exiting = rt.exiting.get(sessionId);
  if (exiting) {
    exiting.held.push({ message: { ...message, at: message.at ?? Date.now(), seq: message.seq ?? arrival() }, summarizeTo, threadId });
    return true;
  }
  // Shutting down: a new CLI would outlive Postbox. A message you sent waits in the queue (turnExited).
  return Boolean(rt.closing);
}

/**
 * Takes out of the live turn’s queue the messages `carries` picks, which no longer wait for it: update_block’s refusal
 * gave the agent the answer one held (#1810). Beside waitsBehind, which fills it: only Turns writes a turn’s queue
 * (designs/architecture/services.md, “Running”). Returns what it took.
 * @param {any} rt @param {string} sessionId @param {(message: any) => boolean} carries
 */
export function takeQueued(rt, sessionId, carries) {
  const pending = rt.running.turnOf(sessionId)?.pending ?? [];
  const taken = pending.filter((/** @type {any} */ p) => carries(p.message));
  if (taken.length) pending.splice(0, pending.length, ...pending.filter((/** @type {any} */ p) => !taken.includes(p)));
  return taken;
}

/**
 * The message as the turn reads it: a pointer for a mention it already read, Postbox’s waiting notices, a note that
 * its tools didn’t load, the lint it owes, and its thread’s context.
 * @param {any} rt @param {any} se @param {any} message @param {string} where @param {boolean} slash
 */
function turnMessage(rt, se, message, where, slash) {
  const sessionId = se.id;
  // A plain batch is given turn-input.mjs’s text, built now, with the room’s tail in it, so no catch-up follows (#1427).
  const input = message.kind === 'input';
  if (input) {
    // What else it carries (a Retry’s `woken` and `retry`) stays; its entries and plain parts are on what was asked.
    const { entries: _entries, messages: _parts, ...carried } = message;
    message = { ...carried, ...inputOf(rt, se, message, where) };
  }
  // Postbox’s notices that waited for this agent’s next turn (tellAgent: what became of its earlier messages) lead the
  // background; the brief isn’t context, it goes with the room’s facts (turnFacts).
  if (se.context?.length && !slash) {
    // Not an urgent note to stop a subagent (#229): its turn ended, and the subagent with it.
    message = { ...message, context: [...notUrgent(se.context), ...(message.context ?? [])] };
    rt.sessions.update(sessionId, (now) => ({ context: (now.context ?? []).filter((/** @type {string} */ x) => !se.context.includes(x)) })); // only what it read
  }
  // Postbox’s tools didn’t load last turn: told once, whatever the backend (tools-down.mjs).
  const down = toolsDownNote(se, message);
  if (down) message = { ...message, context: [down, ...(message.context ?? [])] };
  if (down) saveBackendState(rt, sessionId, { postboxToolsDown: null });
  if (down) message = { ...message, toolsDownTaken: se.backendState.postboxToolsDown };
  // Problems the checks found in its last reply, still waiting to go as a lint turn, come with this turn instead, as
  // message.lint: fixes it owes, placed with the request rather than in the background.
  if (message.kind !== 'lint' && !slash) message = rt.checks.foldLint(sessionId, message);
  if (input) return message;
  // A topic or side thread’s request leads; its room catch-up is background. A room turn keeps the existing order. What
  // still waits for the agent as an entry stays out of it, the person’s messages and agents’ mentions alike: each is
  // given in its own turn, whole, so a summary never gives it first (#484), as inputOf leaves them out of a tail.
  const waiting = rt.delivery
    .waiting(sessionId)
    .map((/** @type {any} */ e) => e.itemId)
    .filter(Boolean);
  return rt.memory.turnContext(rt.store.pending.session(sessionId) ?? rt.s.sessions[sessionId], where, message, slash, waiting);
}

/**
 * A new turn’s record, before it runs.
 * @param {any} se @param {any} message @param {any} persona
 * @param {{ where: string, slash: boolean, summarizeTo: string|null, asked: any }} opts
 */
function newTurn(se, message, persona, { where, slash, summarizeTo, asked }) {
  // An input’s plain parts say who it’s from, as a batch’s did (turns.mjs).
  const said = message.as ?? message;
  return {
    // An id chosen before the turn, by the take of its inbox entries (turns.mjs), or a new one.
    id: typeof message.turnId === 'string' ? message.turnId : newId('turn'),
    kind: said.kind,
    // Whether this is the person moving on (#69): their message or an event of theirs, not another agent’s review (#133).
    movesOn: said.kind === 'user' || (message.kind === 'event' && !message.event?.from),
    from:
      said.kind === 'agent'
        ? String(said.from ?? '')
            .replace(/^@/, '')
            .toLowerCase()
        : null,
    sessionId: se.id,
    // The backend it started on: a persona changed mid-turn reaches the next turn, not this one (#220).
    backend: persona?.backend ?? 'mock',
    // And the mode: the person’s hooks load at its start in some modes only, and stay as they loaded (#806, #1030).
    mode: persona?.permissionMode ?? 'auto',
    threadId: where,
    promptFirst: firstPromptSection(message, where !== se.threadId),
    segment: null,
    first: null,
    steps: [],
    partWords: {}, // each part’s words so far, by its id (reply-segment.mjs, placeStep)
    abort: new AbortController(),
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
    // Whom its reply goes back to, for a turn that takes no entries to read it from: a retry of one that took none
    // (#1541), or a host turn continued (continueAs, #1538). Null: read from what it takes (reply-back.mjs).
    backTo: Array.isArray(message.backTo) ? message.backTo : null,
    startedAt: Date.now(),
    // This turn’s own MCP token: a call that carries another turn’s, such as a stopped one’s, is refused (#126).
    token: randomUUID(),
    /** @type {Promise<void>} resolves once the adapter is done, which for a real backend is when its process has exited */
    exited: Promise.resolve(),
    /** @type {Set<string>} background jobs Stop was asked to keep running (#129) */
    keepJobs: new Set(),
    asked,
  };
}

/** Who a turn answers, for the side thread’s line that shows it at work: an agent by its handle, or you. @param {any} turn */
function startedBy(turn) {
  if (turn.kind === 'agent') return turn.from;
  return turn.kind === 'user' ? 'you' : null;
}

/**
 * The session shows the agent at work on the turn, which takes the rules the person allowed once.
 * @param {any} rt @param {any} se @param {any} turn
 */
function atWork(rt, se, turn) {
  const where = turn.threadId;
  // Rules the person allowed once (from a refusal card) apply to this turn only.
  turn.allowOnce = se.allowOnce ?? [];
  rt.sessions.update(se.id, {
    allowOnce: [],
    endingSubagents: [],
    glimpse: '',
    // Where the turn is, when it’s in a side thread (#121): the conversation shows the agent at work there.
    sideTurn: where === se.threadId ? null : { threadId: where, by: startedBy(turn) },
    state: 'think',
    // Moving on clears a need tied to a turn; the cards that wait until answered stay (card-needs.mjs RANK).
    needs: turn.movesOn && rt.turnService.asks.turnTied(se.needs?.kind) ? null : se.needs,
    // This turn is the last turn from its start (card-needs.mjs turnsOf), so a restart that cuts it off, or a card
    // released after it leaves the running turns, doesn't count a block from the turn before.
    lastTurnId: turn.id,
    // A turn that doesn't move on keeps the turns still asking you something, so their refusals and tool requests
    // count until you move on (card-needs.mjs keptTurns). Read before this patch moves lastTurnId on.
    keptTurnIds: turn.movesOn ? [] : rt.turnService.asks.keptTurns(se),
    // A turn that doesn't move on keeps the block it found waiting (#69): it counts mid-turn, at the turn's end and
    // after a restart (card-needs.mjs `keep`), even if a permission takes the need meanwhile. In the store, as above.
    keptId: !turn.movesOn && se.needs?.kind === 'block' ? se.needs.itemId : null,
    currentStep: 'Thinking',
    finishedAt: null,
  });
}

/**
 * The plain message a turn answers, for Postbox’s own scripted backend (the mock), which picks its script by a message’s
 * kind, sender and words where a model reads the prompt: an input’s batch as it was asked, with the input’s text and
 * what rode with it as its context (#1427); any other message as it is. @param {any} turn @param {any} message
 */
function plainOf(turn, message) {
  const asked = turn.asked?.message;
  if (message.kind !== 'input' || !asked?.as) return message;
  return { ...asked, kind: asked.as.kind, context: [message.text, ...(message.context ?? [])] };
}

/**
 * The adapter runs the turn; it ends through endTurn, and its exit lets the session’s next turn start.
 * @param {any} rt @param {any} se @param {any} turn @param {any} message
 * @param {{ adapter: any, persona: any, hostId: string|null }} how
 */
function runTurn(rt, se, turn, message, { adapter, persona, hostId }) {
  // With the turn’s last raw lines, which each adapter’s recorder keeps (recorderFor), for an empty reply (#485).
  // And the files attached to its message, which its agent may read (#1307): a host turn reads its own copies of them.
  const base = adapterContext(rt, se, turn);
  const ctx = Object.assign(base, { rawTail: turn.rawTail, readFiles: hostId ? [] : attachedFiles(message, base.pathOf), plain: plainOf(turn, message) });
  // A remote turn has its host’s welcome, its host turn and the conversation’s snapshot before the adapter starts.
  const run = Promise.resolve().then(async () => {
    if (!adapter) refuseUnregistered(se, persona);
    if (!hostId) rt.placement.refuseHere(se, persona);
    const sent = hostId ? await rt.remote.prepare(turn, ctx, message) : message;
    // A host turn attached again while its run clock holds the agent: stopped once the adapter follows it, so the stop
    // names its host turn and goes to the host, and the clock hears when the host confirms it (#1526).
    if (turn.clockStops) queueMicrotask(() => rt.runClock?.stopHeld(turn));
    return adapter.deliver(rt.s.sessions[turn.sessionId], sent, ctx);
  });
  turn.exited = run.then(
    () => {},
    () => {},
  );
  run.then(
    () => endTurn(rt, turn, null),
    (err) => endTurn(rt, turn, err),
  );
  // The chain’s count resets once the chain ends (#541). While the store can’t be written, that write waits behind the
  // exit’s own (turnExited), which also waits, so it runs after the session has left exiting and sees the chain ended.
  void turn.exited.then(() => turnExited(rt, turn)).then(() => whenWritable(rt, () => endChain(rt, turn.threadId)));
}

/**
 * Retry a failed reply: sends the same message again, or a promise of that when it’s read back from the store first.
 * onSend runs once it’s sent, before the turn starts, so what it tells the agent reaches that turn and no other (#1713).
 * @param {any} rt @param {string} threadId @param {string} itemId @param {() => void} [onSend]
 */
export function retry(rt, threadId, itemId, onSend) {
  const it = rt.store.item(threadId, itemId);
  if (it?.status !== 'failed') throw httpError(409, 'Only a failed reply can be retried.');
  // With run clocks on: a clock that holds the agent would only hold the retry, so it’s refused (#1526).
  if (rt.runClock) refuseWhileHeld(rt, it.sessionId, 'retry');
  // What it was asked (turn-marks.mjs): refused, with nothing sent, when it was kept and can’t be read back exactly.
  return askedAgain(rt, threadId, it, (asked) => {
    onSend?.();
    rt.threads.patchItem(threadId, itemId, { status: 'retried' });
    // Only the cards that wait until answered can take the need: the failed turn's own asks would flash until the
    // retried turn starts, and that turn's end decides them.
    rt.turnService.asks.releaseNeed(rt.s.sessions[it.sessionId], itemId, undefined, { turnIds: [] });
    // Whom the failed reply already handed work to (#485), so the retry doesn't hand it over again.
    const woken = it.wokeOnFailure ?? [];
    // A turn that took entries: they reopen as a resend, and the turn that takes them is built from them, so nothing
    // sends the asked message again (#1429).
    if (it.turnId && rt.turnService.retryEntries(it.sessionId, it.turnId, woken)) return;
    // One that took none, such as a host turn's replay or a message a test sent: its request goes again.
    const message = { ...asked.message, retry: true, woken, backTo: asked.backTo, turnId: newId('turn'), entriesWait: true };
    rt.turnService.run(it.sessionId, message, { summarizeTo: asked.summarizeTo, threadId });
  });
}
