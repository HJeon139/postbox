// What a step keeps of its call: its input in one line and the end of what it returned, each bounded by STEP_TEXT.
// The core builds them (server/harness-tools.mjs) and the runtime bounds every step with the same functions
// (server/runtime.mjs, a turn’s activity), so a cut is made, and marked, in one place. turnStep, the step a turn keeps,
// moved from server/runtime.mjs.

import { STEP_TEXT } from '../shared/limits.mjs';

// The most of one field a step shows, so the next field still fits on the line.
const FIELD = 120;
// A path keeps its start and its file name, cut between them.
const PATH = /^(?:[a-z]+:\/\/|~|\.{0,2}\/|[A-Za-z]:\\)\S*$/;

/** A field’s value cut to n: a path in its middle, so the file name stays; anything else at its end. */
function cut(/** @type {string} */ s, /** @type {number} */ n) {
  if (s.length <= n) return s;
  if (!PATH.test(s)) return `${s.slice(0, n - 1)}…`;
  const tail = Math.ceil((n - 1) * 0.7);
  return `${s.slice(0, n - 1 - tail)}…${s.slice(-tail)}`;
}

/**
 * A call’s input in one line, for its step: a string as it is, an object as its fields (`command: npm test`), each
 * value cut short, so a file’s whole contents never ride a step. @param {unknown} input
 */
export function stepInput(input) {
  if (typeof input === 'string') return cut(input, STEP_TEXT.input);
  if (!input || typeof input !== 'object') return '';
  const parts = [];
  for (const [k, v] of Object.entries(input)) {
    const value = String((typeof v === 'string' ? v : JSON.stringify(v)) ?? '').replace(/\s+/g, ' ');
    parts.push(`${k}: ${cut(value, FIELD)}`);
    if (parts.join(' · ').length > STEP_TEXT.input) break;
  }
  return cut(parts.join(' · '), STEP_TEXT.input);
}

/**
 * The end of what a call returned, for its step. Cut, it starts at a whole line, marked, so no line reads as if it
 * were whole; the mark is within the bound, so cutting it again changes nothing. @param {unknown} text
 */
export function stepOutput(text) {
  const t = String(text ?? '').trim();
  if (t.length <= STEP_TEXT.output) return t;
  const tail = t.slice(-(STEP_TEXT.output - 1));
  const line = tail.indexOf('\n');
  return `…${line >= 0 && line < tail.length - 1 ? tail.slice(line + 1) : tail}`;
}

const STEP_STATES = new Set(['running', 'done', 'failed', 'denied', 'stopped']);
/** What a step is when it isn’t a tool call (#73): a thought, a subagent’s narration, or a subagent’s own step. */
const STEP_KINDS = /** @type {Set<unknown>} */ (new Set(['thought', 'said', 'agent']));

/** A step’s state, or done for one Postbox doesn’t know. @param {unknown} state */
export const stepState = (state) => (STEP_STATES.has(/** @type {string} */ (state)) ? /** @type {string} */ (state) : 'done');

/**
 * The step a turn keeps, from what its activity was told: each field bounded, and only the ones it has.
 * @param {{ id: string, label: unknown, state: unknown, ms: number|null, who: unknown, parent: unknown, detail: unknown, kind: unknown, job: unknown, input: unknown, output: unknown }} f
 */
export function turnStep({ id, label, state, ms, who, parent, detail, kind, job, input, output }) {
  return {
    id,
    label: String(label).slice(0, 200),
    state: stepState(state),
    ms,
    ...(who ? { who: String(who).slice(0, 40) } : {}),
    ...(typeof parent === 'string' && parent ? { parent: parent.slice(0, 100) } : {}),
    ...(detail ? { detail: String(detail).slice(0, 1200) } : {}),
    ...(STEP_KINDS.has(kind) ? { kind } : {}),
    ...(typeof job === 'string' && job ? { job: job.slice(0, 60) } : {}),
    // Its call’s input and the end of what it returned, bounded as the core bounds them.
    ...(input ? { input: stepInput(String(input)) } : {}),
    ...(output ? { output: stepOutput(output) } : {}),
  };
}
