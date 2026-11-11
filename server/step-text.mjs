// What a step keeps of its call: its input in one line and the end of what it returned, each bounded by STEP_TEXT.
// The core builds them (server/harness-tools.mjs) and the runtime bounds every step with the same functions
// (server/runtime.mjs, a turn’s activity), so a cut is made, and marked, in one place.

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
