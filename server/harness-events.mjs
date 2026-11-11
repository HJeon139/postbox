// The harness-event contract: the one way an adapter tells Postbox what its harness did in a turn. Each adapter reads
// its harness’s own stream (Claude Code’s stream-json, Codex’s app server, the Kiro and Antigravity CLIs, the mock’s
// scripts) and calls event() with these kinds, in its harness’s order:
//
// - text      { text, block?, parent? }   words of the reply; a new block starts a new paragraph. With parent, a
//                                          subagent’s own words: a step in its voice, never the reply (#73).
// - thinking  { text, block?, parent?, whole? }   a piece of a thought; whole, or a thinking_end, makes it a step.
// - thinking_end { block }
// - tool_call { id, name, input?, parent?, final? }   a call, named as Claude Code names its tools (Bash, Read, Edit,
//                                          Write, WebSearch, Agent, mcp__<server>__<tool>); again with its input, and
//                                          final once that input is whole. An Agent or Task call starts a subagent.
// - tool_result { id, isError?, text?, result?, vcsCwd?, background?, parent? }   what it returned; background: it may
//                                          have gone on as a job ({ job, named, outputFile }) or a subagent ({ agent }).
// - tool_end  { id?, job?, status, summary?, outputFile? }   a call that went on in the background ended.
// - refused   { id, tool, input?, agentId?, reason?, reasonType?, fromResult? }   the harness refused a call itself.
// - task      { task, id }                 a subagent’s own id (a refusal’s agentId), for the call that started it.
// - context   { percent, parent? }         how much of the context window the last request used.
// - progress  { text, parent? }            what a subagent, or the harness, says it’s doing now.
// - status    { state?, step? }            the harness’s own state, such as summarizing the conversation.
// - message_end { calledTools }            the model ended a message; one that called no tool waits on what runs on.
// - compaction { kept, total, summary }    the harness summarized the conversation to make room.
// - turn_end  { isError?, text? }          the turn ended; text, a reply no text event carried (#485).
//
// From these, and only here, Postbox builds what it shows and keeps: the reply’s text, each step and its label, the
// work ledger’s calls, background jobs, the subagents on the ring, the glimpse and the ring’s state. Moved from
// server/adapters/claude-stream.mjs, which built them for Claude Code alone, while each other adapter built its own.

import { HarnessText } from './harness-text.mjs';
import { firstSentence, HarnessTools, moveSubagent, SUBAGENT_TOOLS } from './harness-tools.mjs';
import { describeTool } from './tool-labels.mjs';

// How Postbox answers a call the person declined on a permission card: that’s their answer, not a refusal to show again.
const DECLINED = /^The person didn’t allow/;

/** The kinds of event the contract has, each the method that takes it. */
export const KINDS = Object.freeze([
  'text',
  'thinking',
  'thinking_end',
  'tool_call',
  'tool_result',
  'tool_end',
  'refused',
  'task',
  'context',
  'progress',
  'status',
  'message_end',
  'compaction',
  'turn_end',
]);

/** The translator for one turn. Pure apart from the ctx calls, so recorded streams can test it. */
export class HarnessEvents {
  /** @param {any} ctx  the turn context (server/adapters/adapter.mjs) @param {{ now?: () => number }} [opts] */
  constructor(ctx, { now = Date.now } = {}) {
    this.ctx = ctx;
    /** @type {any} */
    this.st = {
      tools: new Map(), // call id → { name, label, input, who, parent, started, quiet, done, job, async, summary }
      subagents: new Map(), // the call that started it → its entry on the ring (harness-tools.mjs)
      subNames: new Map(), // the call that started a subagent → its name, kept after it finishes
      tasks: new Map(), // a subagent’s own id → the call that started it
      denied: new Set(),
      jobs: new Map(), // background job id → its call’s id, while it runs
      used: new Set(), // call ids the work ledger has
      state: null,
    };
    this.status = this.status.bind(this);
    this.tools = new HarnessTools(ctx, this.st, this.status, now);
    this.words = new HarnessText(ctx, this.status, now);
    this.event = this.event.bind(this);
  }

  /** One event of the contract; a kind it doesn’t have is ignored. @param {{ kind: string } & Record<string, any>} e */
  event(e) {
    if (e && KINDS.includes(e.kind)) /** @type {any} */ (this)[`on_${e.kind}`](e);
  }

  /** The ring’s state and step; a state it’s already in isn’t sent again. @param {any} patch */
  status(patch) {
    if (patch.state && patch.state === this.st.state && Object.keys(patch).length === 1) return;
    if (patch.state) this.st.state = patch.state;
    this.ctx.status(patch);
  }

  /** The subagent behind a call or a subagent id, by name; null for the agent’s own. @param {{ agentId?: string|null, toolUseId?: string|null }} ids */
  who({ agentId = null, toolUseId = null }) {
    return (agentId && this.st.subNames.get(this.st.tasks.get(agentId))) || (toolUseId && this.st.tools.get(toolUseId)?.who) || null;
  }

  /** @param {string|undefined} parent */
  by(parent) {
    return parent ? { who: this.st.subNames.get(parent) ?? 'subagent', parent } : null;
  }

  /** A subagent’s entry moves, and the ring hears it. @param {string|undefined} parent @param {any} change */
  moveSub(parent, change) {
    const sub = parent ? this.st.subagents.get(parent) : null;
    if (!sub) return null;
    moveSubagent(sub, change);
    this.tools.pushSubagents();
    return sub;
  }

  /** @param {any} e */
  on_text(e) {
    if (!e.parent) return this.words.write(e.text, e.block);
    this.moveSub(e.parent, { state: 'gen', ...(e.text?.trim() ? { said: e.text } : {}) });
    this.words.narrate(e.text, this.by(e.parent));
  }

  /** @param {any} e */
  on_thinking(e) {
    if (!e.parent) return this.words.think(e.text, e.block, e.whole);
    this.moveSub(e.parent, { state: 'think', ...(e.text ? { doing: firstSentence(e.text, 120), thinking: true } : {}) });
    if (e.whole && e.text) this.words.thoughtStep(e.text, this.by(e.parent));
  }

  /** @param {any} e */
  on_thinking_end(e) {
    this.words.thought(e.block);
  }

  /** @param {any} e */
  on_tool_call(e) {
    this.tools.start(e.id, e.name, e.input ?? {}, this.by(e.parent));
    if (e.input) this.tools.input(e.id, e.input, e.final === true);
    this.moveSub(e.parent, { state: 'tool', doing: describeTool(e.name, e.input) });
  }

  /** What a call returned: it ends, or goes on as a job or a subagent, and the ledger hears it. @param {any} e */
  on_tool_result(e) {
    const t = this.st.tools.get(e.id);
    const bg = e.background;
    const job = !e.isError && bg?.job && t && !t.done && !SUBAGENT_TOOLS.has(t.name) && (bg.named || t.input?.run_in_background === true);
    if (job) this.tools.startJob(e.id, { job: String(bg.job), outputFile: bg.outputFile ?? null });
    else if (!e.isError && bg?.agent && this.st.subagents.has(e.id)) this.tools.startAsyncAgent(e.id);
    else this.tools.end(e.id, e.isError === true, e.isError ? (e.text ?? '') : '');
    this.ctx.toolResult?.({ id: e.id, isError: e.isError === true, text: e.text ?? '', result: e.result ?? null, vcsCwd: e.vcsCwd ?? null });
    if (!e.parent) this.status({ state: 'think', currentStep: 'Thinking' });
  }

  /** A call that went on in the background ended, maybe long after its result (#129). @param {any} e */
  on_tool_end(e) {
    if (e.job && this.st.jobs.has(e.job)) this.tools.endJob(e.job, e.status, e.summary);
    else if (e.id && this.st.subagents.has(e.id)) this.tools.endAgent(e.id, e.status, e.summary);
    if (e.id) this.ctx.taskEnded?.({ toolUseId: e.id, status: String(e.status ?? ''), summary: e.summary ?? '', outputFile: e.outputFile ?? null });
  }

  /**
   * The harness refused a call without asking: reported as it happens, and again in its result, so each is passed on
   * once. A call the person declined on a card is their answer, not a refusal. @param {any} e
   */
  on_refused(e) {
    if (!e.id || this.st.denied.has(e.id)) return;
    const t = this.st.tools.get(e.id);
    if (e.fromResult && DECLINED.test(t?.error ?? '')) return;
    this.st.denied.add(e.id);
    const input = e.input ?? t?.input ?? {};
    const who = e.agentId ? (this.st.subNames.get(this.st.tasks.get(e.agentId)) ?? 'a subagent') : (t?.who ?? null);
    const reason = firstSentence(e.reason ?? t?.error ?? '');
    this.ctx.denied?.({ toolUseId: e.id, tool: e.tool, input, label: describeTool(e.tool, input), reason, reasonType: e.reasonType ?? null, who });
    if (t?.done && !t.quiet) this.ctx.activity(this.tools.stepOf(e.id, t, 'denied'));
  }

  /** @param {any} e */
  on_task(e) {
    this.st.tasks.set(e.task, e.id);
  }

  /** @param {any} e */
  on_context(e) {
    if (e.parent) this.moveSub(e.parent, { ctx: e.percent });
    else this.status({ ctx: e.percent });
  }

  /** @param {any} e */
  on_progress(e) {
    if (!e.parent) return this.words.glimpse(e.text);
    const sub = this.moveSub(e.parent, { doing: e.text });
    if (sub) this.words.glimpse(`${sub.name}: ${e.text}`);
  }

  /** @param {any} e */
  on_status(e) {
    this.status({ ...(e.state ? { state: e.state } : {}), ...(e.step ? { currentStep: e.step } : {}) });
  }

  /** A message that called no tool, while subagents work on in the background: it waits on them (#189). @param {any} e */
  on_message_end(e) {
    if (!e.calledTools) this.tools.waiting([], this.tools.asyncAgents());
  }

  /** @param {any} e */
  on_compaction(e) {
    if (e.total) this.ctx.compaction({ kept: e.kept, total: e.total, summary: e.summary });
    this.words.compacted();
  }

  /** The turn ended: a reply no event carried, the calls still open, and what runs on after it. @param {any} e */
  on_turn_end(e) {
    this.words.fromResult(e);
    const agents = this.tools.asyncAgents();
    const running = new Set([...this.st.jobs.values(), ...agents]);
    // A background subagent’s own calls run on with it, at any depth.
    const under = (/** @type {any} */ t, n = 0) => !!t?.parent && n < 20 && (running.has(t.parent) || under(this.st.tools.get(t.parent), n + 1));
    for (const [id, t] of this.st.tools) if (!running.has(id) && !under(t)) this.tools.end(id, e.isError === true);
    this.tools.waiting([...this.st.jobs.keys()], agents);
    this.words.flush();
  }
}
