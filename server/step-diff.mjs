// The lines an edit changes, for its step: how many it adds and removes, and the first few as a small diff, so the
// newest step of a running turn shows what it changed, as its harness does (designs/rooms-at-scale.md, “Live state”).
// Read from the call’s input in Claude Code’s names: Edit’s old_string and new_string, MultiEdit’s edits, and Write’s
// content, which adds every line; or from a unified diff, for a harness that says its change that way (Codex).

import { STEP_TEXT } from '../shared/limits.mjs';

// The most lines a step’s diff shows, and of each line; the whole stays within STEP_TEXT.output.
const LINES = 8;
const WIDTH = 120;

/** A string’s lines, without the empty one after a last newline. @param {unknown} s @returns {string[]} */
const linesOf = (s) => (typeof s === 'string' && s ? s.replace(/\n$/, '').split('\n') : []);

/**
 * One replacement’s changed lines: the lines old and new share at their start and end are context, not change.
 * @param {string[]} before @param {string[]} after
 */
function changed(before, after) {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0;
  while (end < before.length - start && end < after.length - start && before.at(-1 - end) === after.at(-1 - end)) end++;
  return { removed: before.slice(start, before.length - end), added: after.slice(start, after.length - end) };
}

/** The replacements a call makes, as [old, new] pairs. @param {string} name @param {any} i */
function replacements(name, i) {
  if (name === 'Edit') return [[i.old_string, i.new_string]];
  if (name === 'MultiEdit' && Array.isArray(i.edits)) return i.edits.map((/** @type {any} */ e) => [e?.old_string, e?.new_string]);
  if (name === 'Write') return [['', i.content]];
  return [];
}

/** A unified diff’s changed lines, by hunk, without its headers. @param {string} patch */
function patchChanges(patch) {
  const lines = linesOf(patch).filter((l) => !/^(?:---|\+\+\+) /.test(l));
  return [{ removed: lines.filter((l) => l[0] === '-').map((l) => l.slice(1)), added: lines.filter((l) => l[0] === '+').map((l) => l.slice(1)) }];
}

/**
 * The step fields for an edit’s change: { added, deleted, diff }, or none for a call that changes no lines it says.
 * @param {string} name @param {unknown} input @param {unknown} [patch]  the change as a unified diff, when its harness says it so
 * @returns {{ added?: number, deleted?: number, diff?: string }}
 */
export function stepDiff(name, input, patch) {
  const i = /** @type {any} */ (input ?? {});
  let added = 0;
  let deleted = 0;
  /** @type {string[]} */
  const shown = [];
  const changes = typeof patch === 'string' ? patchChanges(patch) : replacements(name, i).map(([before, after]) => changed(linesOf(before), linesOf(after)));
  for (const c of changes) {
    deleted += c.removed.length;
    added += c.added.length;
    for (const [mark, l] of [...c.removed.map((l) => ['-', l]), ...c.added.map((l) => ['+', l])]) {
      const line = `${mark}${l.length > WIDTH ? `${l.slice(0, WIDTH - 1)}…` : l}`;
      // Whole lines, as many as fit the step’s bound.
      if (shown.length < LINES && [...shown, line].join('\n').length <= STEP_TEXT.output) shown.push(line);
    }
  }
  if (!added && !deleted) return {};
  return { added, deleted, diff: shown.join('\n') };
}
