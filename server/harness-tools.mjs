// A turn’s tool calls, background jobs and subagents, as the harness-event contract reports them
// (server/harness-events.mjs): each call’s step and its label, the work ledger’s record of it, a job’s record, and each
// subagent’s entry on the agent’s ring. One place for every backend: each adapter only says what its harness did.
// Moved from server/adapters/claude-stream.mjs, which built these for Claude Code alone.

import { glimpseOf } from '../shared/text.mjs';
import { describeTool, QUIET } from './tool-labels.mjs';

/** The calls that start a subagent. */
export const SUBAGENT_TOOLS = new Set(['Task', 'Agent']);
const JOB_STATES = { completed: 'done', failed: 'failed', stopped: 'stopped', killed: 'stopped' };
const BACKGROUND_ENDS = { done: 'Finished in the background', failed: 'Failed in the background', stopped: 'Stopped in the background' };

export const clip = (/** @type {unknown} */ s, /** @type {number} */ n) => {
  const t = String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
/** The first sentence of a message, such as a refusal’s reason. */
export const firstSentence = (/** @type {unknown} */ s, n = 300) => clip(/^[\s\S]*?[.!?](?=\s|$)/.exec(String(s ?? '').trim())?.[0] ?? s, n);
/** A subagent’s step names it, and nests under the call that started it (#73). @param {any} by */
export const byOf = (by) => (by?.who ? { who: by.who, ...(by.parent ? { parent: by.parent } : {}) } : {});
/** What a subagent was asked to do, in a line: its call’s description, else its prompt’s first sentence. */
const askedOf = (/** @type {any} */ input) => clip(input?.description || firstSentence(input?.prompt ?? '', 120), 120);
/** How a call ended: refused by its harness, failed, stopped, or done. @param {boolean} denied @param {boolean} failed @param {boolean} stopped */
function endState(denied, failed, stopped) {
  if (denied) return 'denied';
  if (failed) return 'failed';
  return stopped ? 'stopped' : 'done';
}
const jobState = (/** @type {unknown} */ s) => JOB_STATES[/** @type {keyof typeof JOB_STATES} */ (s)] ?? 'done';

export class HarnessTools {
  /** @param {any} ctx @param {any} st  the translator’s state @param {(patch: any) => void} status @param {() => number} now */
  constructor(ctx, st, status, now) {
    this.ctx = ctx;
    this.st = st;
    this.status = status;
    this.now = now;
  }

  pushSubagents() {
    this.status({ subagents: [...this.st.subagents.values()] });
  }

  /** The work ledger (#132) gets each call once, with its whole input, as soon as it’s known. @param {string} id @param {any} t */
  used(id, t) {
    if (this.st.used.has(id)) return;
    this.st.used.add(id);
    this.ctx.toolUse?.({ id, name: t.name, input: t.input ?? {}, who: t.who, ...(t.parent ? { parent: t.parent } : {}) });
  }

  /** @param {string} id @param {any} t @param {string} state @param {Record<string, unknown>} [extra] */
  stepOf(id, t, state, extra = {}) {
    return { id, label: t.label, state, ms: this.now() - t.started, ...byOf(t), ...extra };
  }

  /** A call starts: its step, unless it shows as what it makes, and a subagent’s entry. @param {string} id @param {string} name @param {any} input @param {any} by */
  start(id, name, input, by = null) {
    if (this.st.tools.has(id)) return;
    const who = by?.who ?? null;
    const quiet = QUIET.test(name);
    const label = describeTool(name, input);
    this.st.tools.set(id, { name, label, input, who, parent: by?.parent ?? null, started: this.now(), quiet });
    if (!quiet) this.ctx.activity({ id, label, state: 'running', ...byOf(by), ...(SUBAGENT_TOOLS.has(name) ? { kind: 'agent' } : {}) });
    else if (!who) this.status({ state: 'tool', currentStep: label });
    if (SUBAGENT_TOOLS.has(name)) this.startSubagent(id, input, by);
    if (!who) this.status({ state: 'tool' });
  }

  /** @param {string} id @param {any} input @param {any} by */
  startSubagent(id, input, by) {
    const name = clip(input?.subagent_type ?? input?.description ?? 'subagent', 40);
    // ctx: unknown until its own usage arrives, shown as unavailable rather than 0% (#189).
    this.st.subagents.set(id, {
      id,
      name,
      state: 'think',
      ctx: null,
      asked: askedOf(input),
      doing: clip(input?.description, 120),
      thinking: false,
      said: '',
      since: false,
      parent: by?.parent ?? null,
      bg: input?.run_in_background === true,
    });
    this.st.subNames.set(id, name);
    this.pushSubagents();
  }

  /** Its input is known now, whole when `final`: its label, the ledger, its subagent. @param {string} id @param {any} input @param {boolean} [final] */
  input(id, input, final = false) {
    const t = this.st.tools.get(id);
    if (!t) return;
    if (input && (final || Object.keys(input).length)) {
      t.input = input;
      this.used(id, t);
    }
    const label = describeTool(t.name, input);
    if (label !== t.label) {
      t.label = label;
      if (!t.quiet) this.ctx.activity({ id, label, state: 'running', ...byOf(t) });
      else if (!t.who) this.status({ currentStep: label });
    }
    const sub = this.st.subagents.get(id);
    if (!sub || !input) return;
    sub.name = clip(input.subagent_type ?? input.description ?? sub.name, 40);
    sub.asked = askedOf(input) || sub.asked;
    sub.doing = clip(input.description ?? sub.doing, 120);
    sub.bg = sub.bg || input.run_in_background === true;
    this.st.subNames.set(id, sub.name);
    this.pushSubagents();
  }

  /**
   * A call ends: its step says how, a subagent’s what it returned, and one its harness refused why (`reason`).
   * @param {string} id @param {boolean} failed @param {string} [detail]
   */
  end(id, failed, detail = '', { stopped = false, reason = '' } = {}) {
    const t = this.st.tools.get(id);
    if (!t || t.done) return;
    t.done = true;
    this.used(id, t);
    if (failed && detail) t.error = detail;
    const state = endState(this.st.denied.has(id), failed, stopped);
    const told = failed && detail && state !== 'denied' ? detail : t.summary;
    const why = reason || told || (t.async ? BACKGROUND_ENDS[/** @type {'done'} */ (state)] : '');
    if (!t.quiet) this.ctx.activity(this.stepOf(id, t, state, why ? { detail: firstSentence(why, 300) } : {}));
    if (this.st.subagents.delete(id)) this.pushSubagents();
  }

  /** Its result says it went on as a job (#129). @param {string} id @param {{ job: string, outputFile?: string|null }} bg */
  startJob(id, { job, outputFile = null }) {
    const t = this.st.tools.get(id);
    if (!t || t.done) return;
    t.job = job;
    this.st.jobs.set(job, id);
    if (!t.quiet) this.ctx.activity({ id, label: t.label, state: 'running', job, ...byOf(t) });
    this.ctx.job?.({ id: job, toolUseId: id, label: t.label, command: String(t.input?.command ?? ''), outputFile, state: 'running' });
  }

  /** @param {string} job @param {string} status @param {string} [summary] */
  endJob(job, status, summary) {
    const id = this.st.jobs.get(job);
    this.st.jobs.delete(job);
    const t = this.st.tools.get(id);
    const state = jobState(status);
    if (t && !t.done) {
      t.done = true;
      const detail = state === 'failed' && summary ? { detail: firstSentence(summary, 300) } : {};
      if (!t.quiet) this.ctx.activity(this.stepOf(id, t, state, { job, ...detail }));
    }
    this.ctx.job?.({ id: job, state });
  }

  /** Its result says the subagent works on in the background (#73). @param {string} id */
  startAsyncAgent(id) {
    const t = this.st.tools.get(id);
    const sub = this.st.subagents.get(id);
    if (!t || t.done || !sub) return;
    t.async = true;
    sub.bg = true;
    if (!t.quiet) this.ctx.activity({ id, label: t.label, state: 'running', detail: 'Working in the background', ...byOf(t) });
    this.pushSubagents();
  }

  /** A subagent’s task ended: what it returned, and one in the background ends here. @param {string} id @param {string} status @param {string} [summary] */
  endAgent(id, status, summary) {
    const t = this.st.tools.get(id);
    if (!t) return;
    if (typeof summary === 'string' && summary.trim()) t.summary = summary;
    const state = jobState(status);
    if (t.async) this.end(id, state === 'failed', state === 'failed' ? (summary ?? '') : '', { stopped: state === 'stopped' });
  }

  /** The subagent calls still working in the background. */
  asyncAgents() {
    return [...this.st.tools].filter(([, t]) => t.async && !t.done).map(([id]) => id);
  }

  /** The agent’s step while background jobs or subagents run on after its reply. @param {string[]} jobs @param {string[]} agents */
  waiting(jobs, agents) {
    const n = jobs.length || agents.length;
    if (!n) return;
    const what = jobs.length ? 'background job' : 'background subagent';
    this.status({ state: 'tool', currentStep: n === 1 ? `Waiting for a ${what}` : `Waiting for ${n} ${what}s` });
  }
}

/**
 * A subagent’s ring moves with what it does: its state, its step now (a thought when thinking), and its latest
 * narration (#73). `since`: its step changed after its narration, so the line says both.
 * @param {any} sub @param {{ state?: string, doing?: string, thinking?: boolean, said?: string, ctx?: number }} change
 */
export function moveSubagent(sub, { state, doing, thinking = false, said, ctx: pct }) {
  if (state) sub.state = state;
  if (typeof pct === 'number') sub.ctx = pct;
  if (doing !== undefined) {
    if (clip(doing, 120) !== sub.doing) sub.since = !!sub.said;
    sub.doing = clip(doing, 120);
    sub.thinking = thinking;
  }
  if (said) {
    sub.said = glimpseOf(firstSentence(said, 400));
    sub.since = false;
  }
}
