// What a turn's adapter is given (adapterContext): the turn's settings and permissions, and the callbacks through which
// it reports its words, steps, status, compactions, model and sources as the turn runs. Moved from
// server/runtime.mjs (#1236), where it was turnContext; turn-run.mjs's runTurn calls it.

import { glimpseOf } from '../shared/text.mjs';
import { cutText } from '../shared/text-parts.mjs';
import { EFFORT_LEVELS } from './adapters/setup.mjs';
import { liveFields, liveStep, liveUpdate } from './live-buffer.mjs';
import { liveText } from './live-text.mjs';
import { recordQuota, reportedAt } from './quota-usage.mjs';
import { placeStep, replySegment, stepTaken, wordsSegment } from './reply-segment.mjs';
import { recordScheduledTool } from './scheduled-wakes.mjs';
import { turnStep } from './step-text.mjs';
import { newId } from './store.mjs';
import { saveBackendState } from './store-outage.mjs';
import { promptHook } from './turn-prompt.mjs';
/**
 * What a turn's adapter runs with: what the turn is, its permissions, and the callbacks it reports through.
 * @param {any} rt  the runtime @param {any} se0  the session as the turn starts @param {any} turn
 */
export function adapterContext(rt, se0, turn) {
  const live = () => !turn.closed;
  const tools = rt.toolsFor(turn.sessionId, turn);
  return {
    ...whatTheTurnIs(rt, se0, turn),
    ...turnHooks(rt, turn, live),
    ...replyWords(rt, se0, turn, live),
    ...stepCallback(rt, se0, turn, live),
    ...reportCallbacks(rt, turn, live),
    // What the turn sends its agent, only in UAT recording mode (server/turn-prompt.mjs).
    ...promptHook(rt, turn),
    // With run clocks on: Stop gave up on the CLI’s group, which outlived SIGKILL (server/adapters/process-group.mjs),
    // so its end isn’t an exit, and a run clock voids its run.
    ...(rt.runClock && {
      unkilled: () => {
        turn.mayRunOn ??= 'unkilled';
      },
    }),
    tools,
  };
}

/**
 * The turn's settings: its signal and MCP address, its persona, project, thread and room, the adapter's saved state,
 * and the permissions the person set for it.
 * @param {any} rt @param {any} se0 @param {any} turn
 */
function whatTheTurnIs(rt, se0, turn) {
  const thread = rt.s.threads[turn.threadId];
  const persona = rt.personas.forSession(se0);
  return {
    signal: turn.abort.signal,
    mcpUrl: `${rt.config.origin}/mcp?session=${encodeURIComponent(turn.sessionId)}&turn=${turn.token}`,
    persona,
    project: rt.s.projects[thread?.projectId] ?? null,
    thread: { id: turn.threadId, title: thread?.title ?? '', kind: thread?.kind ?? 'thread' },
    handles: rt.personas.handles(),
    room: rt.sessions.roomOf(turn.threadId, se0),
    /** What the adapter saved for this session last time, such as its own session id. */
    state: { ...(se0.backendState ?? {}) },
    saveState: (patch) => saveBackendState(rt, turn.sessionId, patch),
    /** Where an attachment can be read on disk, or null. */
    pathOf: (a) => rt.assets.attachmentPath(turn.threadId, a),
    /**
     * Asks the person in the thread; resolves to { allow, message?, updatedInput?, updatedPermissions? }. On a remote
     * turn, req.hostPrompt names the prompt as the host knows it (a Codex request’s codex:<id>), so the host’s
     * expiry of it marks the card (#120).
     */
    askPermission: (req) => (turn.remote ? rt.remote.ask(turn, req) : rt.turnService.asks.requestPermission(turn.sessionId, req)),
    /** Permission rules the person allowed for this turn only, after a refusal (Claude Code rule syntax). */
    allowOnce: [...turn.allowOnce],
    /** Rules the person made for this conversation only (#66): { allow, ask, deny }, passed every turn. */
    rules: { allow: [...(se0.rules?.allow ?? [])], ask: [...(se0.rules?.ask ?? [])], deny: [...(se0.rules?.deny ?? [])] },
    /** Folders the person added for this conversation (#66), passed as --add-dir / additionalDirectories. */
    addDirs: [...(se0.addDirs ?? [])],
  };
}

/**
 * For the work ledger (#132): toolUse, toolResult, taskEnded and usage (turn-work.mjs). A tool’s start also counts
 * toward a scheduled wake’s recovery (scheduled-wakes.mjs), once the ledger has it, as it did when turn-work.mjs called
 * it (designs/architecture/services.md, “How each dependency on waiting code breaks”).
 * @param {any} rt @param {any} turn @param {() => boolean} live
 */
function workCallbacks(rt, turn, live) {
  const work = rt.work.workEvents(turn, live);
  return {
    ...work,
    /** @param {any} u */
    toolUse(u) {
      work.toolUse(u);
      if (live()) recordScheduledTool(rt, turn, u, false);
    },
  };
}

/**
 * What the adapter hands over or reports about the turn itself: its subagents' names, its own controls, the agent's
 * commands, background jobs, refused calls, the work ledger's events and its checkpoint.
 * @param {any} rt @param {any} turn @param {() => boolean} live
 */
function turnHooks(rt, turn, live) {
  return {
    /** The adapter says how to name a subagent from its id (a prompt’s agent id), so its prompt names it. */
    subagentNames(fn) {
      turn.subagentName = fn;
    },
    /**
     * The adapter hands over what it can do while the turn runs, such as { stopJob(job) }, a background job’s own Stop.
     * Settings aren’t among them: a persona’s change applies from its next turn.
     */
    control(c) {
      turn.control = c;
    },
    /**
     * The agent’s skills and commands (#67), from init (names) or the SDK’s supportedCommands() (with descriptions
     * and argument hints): [{ name, description?, argumentHint?, skill? }]. Kept on the session for the / menu.
     */
    commands(list) {
      if (live()) rt.sessions.recordCommands(turn.sessionId, list);
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
    /** A line the agent reads at the start of its next turn, as a Postbox notice (sessions.tell). @param {string} text */
    tell(text) {
      rt.sessions.tell(turn.sessionId, text);
    },
    /** The backend refused a tool call without asking: { toolUseId, tool, input, label, reason, reasonType, who }. */
    denied(d) {
      if (!live()) return;
      rt.ledger.denied(turn, d.toolUseId);
      rt.turnService.asks.recordDenial(turn, d);
    },
    ...workCallbacks(rt, turn, live),
    /**
     * Where this turn ends in the backend’s own transcript, such as { claudeSessionId, uuid }. A topic
     * thread that branches from this turn’s messages forks the agent’s session there.
     */
    checkpoint(ref) {
      turn.checkpoint = ref;
    },
  };
}

/**
 * The reply's words as they stream, a compaction's note, and the sources the reply cites.
 * @param {any} rt @param {any} se0 @param {any} turn @param {() => boolean} live
 */
function replyWords(rt, se0, turn, live) {
  const se = () => rt.s.sessions[turn.sessionId];
  const ensureSegment = () => replySegment(rt, turn, se0);
  return {
    text(delta) {
      if (!live() || !delta) return;
      const id = wordsSegment(rt, turn, se0);
      turn.said += delta;
      turn.partWords[id] = (turn.partWords[id] ?? 0) + delta.length;
      liveText(rt, turn, id, delta); // held for its window, then stored (server/live-text.mjs)
      if (rt.store.pending.session(turn.sessionId)?.state !== 'gen') liveUpdate(rt, turn, { state: 'gen', currentStep: 'Writing a reply' });
    },
    compaction({ kept, total, summary }) {
      if (!live()) return;
      const n = (rt.store.pending.session(turn.sessionId) ?? se()).compactions + 1; // one held behind a commit counts too
      turn.segment = null;
      rt.threads.addItem(turn.threadId, {
        kind: 'system',
        variant: 'compaction',
        handle: se0.handle,
        n,
        kept,
        total,
        summary: cutText(String(summary ?? ''), 20000),
      });
      rt.sessions.update(turn.sessionId, { compactions: n, ctx: Math.round((kept / total) * 100) });
    },
    sources(list) {
      if (!live()) return;
      const id = ensureSegment();
      rt.threads.patchItem(turn.threadId, id, {
        sources: list.slice(0, 50).map((x) => ({
          title: String(x.title ?? ''),
          authors: String(x.authors ?? ''),
          year: x.year ?? null,
          url: x.url ?? null,
          note: x.note ? String(x.note) : '',
        })),
      });
    },
  };
}

/**
 * A step the agent or a subagent takes, as the turn's activity shows it and the session's tool calls count it.
 * @param {any} rt @param {any} se0 @param {any} turn @param {() => boolean} live
 */
function stepCallback(rt, se0, turn, live) {
  const ensureSegment = () => replySegment(rt, turn, se0);
  return {
    // who: the subagent that took the step; parent nests it under its starting step; detail holds an error,
    // thought, narration or subagent result; kind names non-tool work; job names its background job (#73, #129); tool
    // names the tool a call ran.
    activity({
      id,
      label,
      tool = null,
      state = 'running',
      ms = null,
      who = null,
      parent = /** @type {string|null} */ (null),
      detail = null,
      kind = null,
      job = /** @type {string|null} */ (null),
      input = null,
      output = null,
      added = null,
      deleted = null,
      diff = null,
      postbox = false,
    }) {
      if (!live()) return;
      // A lint turn that only calls tools (define_term, say) is quiet: it ends as a one-line note, not a reply.
      if (!turn.first && turn.kind !== 'lint') ensureSegment();
      if (!who) stepTaken(turn);
      const i = turn.steps.findIndex((s) => s.id === id);
      const sid = id ?? newId('st');
      // A step of one of Postbox’s own tools is work only if the tool acted, which its answer says (reply-back.mjs).
      if (postbox) (turn.postboxSteps ??= new Set()).add(sid);
      // A new step of the agent’s own shows in the part it writes in now, after that part’s words so far.
      const place = i < 0 && !who ? placeStep(rt, turn, sid) : {};
      const step = turnStep({ id: sid, label, tool, state, ms, who, parent, detail, kind, job, input, output, ...place, added, deleted, diff });
      if (i >= 0) turn.steps[i] = { ...turn.steps[i], ...step };
      else turn.steps.push(step);
      // Live, and stored at the next commit point (live-buffer.mjs).
      if (turn.first) liveStep(rt, turn, step);
      // A thought or a subagent’s narration is in the list, but it isn’t a tool call.
      if (kind === 'thought' || kind === 'said') return;
      if (state === 'running' && !who) recordScheduledTool(rt, turn, { id, name: label }, false);
      // A subagent’s step is its own: it moves its arc, not the agent’s state or step (#189).
      const own = state === 'running' && !(i >= 0 ? turn.steps[i] : step).who;
      // The calls and the step from the buffer, over what was stored as the turn began; the state stays stored.
      const now = liveFields(rt, turn);
      liveUpdate(rt, turn, {
        ...(own ? { state: 'tool' } : {}),
        toolCalls: [{ name: step.label, state: step.state, ms: step.ms }, ...now.toolCalls.filter((/** @type {any} */ c) => c.name !== step.label)].slice(0, 5),
        toolCount: now.toolCount + (i >= 0 ? 0 : 1),
        ...(own ? { currentStep: step.label } : {}),
      });
    },
  };
}

/**
 * The agent’s status as it works, and what the backend reported about the run: its model, effort and MCP servers, and
 * its quota’s usage (#442).
 * @param {any} rt @param {any} turn @param {() => boolean} live
 */
function reportCallbacks(rt, turn, live) {
  return {
    status(patch) {
      if (!live()) return;
      const allowed = {};
      if (patch.state && ['think', 'gen', 'tool'].includes(patch.state)) allowed.state = patch.state;
      if (patch.ctx === null || typeof patch.ctx === 'number') allowed.ctx = patch.ctx === null ? null : Math.max(0, Math.min(100, Math.round(patch.ctx)));
      if (Array.isArray(patch.subagents))
        // Each with what it was asked, its step now, its latest narration and the subagent that started it (#73).
        allowed.subagents = patch.subagents.slice(0, 12).map((x) => ({
          ...(typeof x.id === 'string' && x.id ? { id: x.id.slice(0, 100) } : {}),
          name: cutText(String(x.name), 40),
          state: x.state,
          ctx: Number.isFinite(x.ctx) ? Math.max(0, Math.min(100, x.ctx)) : null, // null: unknown (#189)
          doing: x.doing ? cutText(String(x.doing), 120) : '',
          ...(x.thinking === true ? { thinking: true } : {}),
          ...(x.asked ? { asked: cutText(String(x.asked), 120) } : {}),
          ...(x.said ? { said: cutText(String(x.said), 200) } : {}),
          ...(x.since === true ? { since: true } : {}),
          ...(typeof x.parent === 'string' && x.parent ? { parent: x.parent.slice(0, 100) } : {}),
          ...(x.bg === true ? { bg: true } : {}),
        }));
      if (typeof patch.currentStep === 'string') allowed.currentStep = cutText(patch.currentStep, 200);
      // A line of what it’s thinking or writing right now; cleared when the turn ends.
      if (typeof patch.glimpse === 'string') allowed.glimpse = glimpseOf(patch.glimpse);
      liveUpdate(rt, turn, allowed);
    },
    /**
     * What the backend reported about the run, kept on the session, bounded:
     * - mcpServers, the MCP servers its init listed with their status ([{ name, status, source? }]), as
     *   se.mcpServers = { at, servers }, for the persona sheet’s list (GET /api/mcp-servers);
     * - model, the model that answered, as se.lastModel, and effort, the effort the turn was started with, as
     *   se.lastEffort (#60): the header shows them, marked when they differ from the persona’s setting.
     */
    /** The backend’s quota usage, kept for the composer’s quota line (quota-usage.mjs). */
    quota(report) {
      if (live()) recordQuota(rt, rt.s.sessions[turn.sessionId], report, reportedAt(report));
    },
    reported(r) {
      if (!live() || !r) return;
      /** @type {any} */
      const patch = {};
      if (typeof r.model === 'string' && r.model.trim()) patch.lastModel = r.model.trim().slice(0, 100);
      if (EFFORT_LEVELS.includes(r.effort)) patch.lastEffort = r.effort;
      if (Object.keys(patch).length) rt.sessions.update(turn.sessionId, patch);
      if (Array.isArray(r.mcpServers))
        rt.sessions.update(turn.sessionId, {
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
  };
}
