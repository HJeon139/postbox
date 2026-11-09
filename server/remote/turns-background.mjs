// A Claude Code turn waiting on a background task (#847): once the model has sent its result, Claude Code keeps its
// process alive until the task ends, and prints nothing meanwhile (tool_progress comes only for a foreground call).
// Its stream lists the open tasks in each `system` event of the adapter’s capabilities.remote.backgroundTasks
// subtype (background_tasks_changed). After its result, while one is listed, the turn isn’t quiet, up to
// QUIET.backgroundMax from when each task was first listed; past that it’s stopped as hung, naming the task.

import { INVISIBLE } from '../../shared/invisible.mjs';
import { QUIET } from '../../shared/limits.mjs';
import { partEnd } from '../../shared/text-parts.mjs';

// How a result line, and a system event’s line, look on stdout: Claude Code writes a system event’s type first.
const RESULT_TYPE = JSON.stringify({ type: 'result' }).slice(1, -1);
const SYSTEM_START = JSON.stringify({ type: 'system' }).slice(0, -1);
/** How much of a task’s description the stop text quotes: the agent wrote it. */
const NAME_CHARS = 80;
// Control characters and lone surrogates (Cs, which the u flag reads one at a time); with INVISIBLE
// (shared/invisible.mjs, #1049), every character that would change how the note reads.
const UNPRINTABLE = /[\p{Cc}\p{Cs}]/gu;

/**
 * Takes in a stdout line: whether the model has sent its result, and the open background tasks. The wait counts only
 * after a result, since a turn quiet mid-turn may be hung whatever it lists. Only a parsed `result`, or a parsed
 * `system` event of the subtype with a `tasks` array, counts, so the same words in an assistant’s text don’t; any later
 * line that isn’t a `system` event means the model is working again. O(line length) for any other line.
 * @param {import('./turns-shared.mjs').Live} live @param {string} text @param {number} now
 */
export function noteBackground(live, text, now) {
  const subtype = live.backgroundTasks;
  if (!subtype) return;
  if (text.includes(RESULT_TYPE) && parsed(text)?.type === 'result') {
    live.resultSent = true;
    return;
  }
  if (!text.startsWith(SYSTEM_START)) {
    live.resultSent = false;
    return;
  }
  if (!text.includes(subtype)) return;
  const e = parsed(text);
  if (e?.subtype !== subtype || !Array.isArray(e.tasks)) return;
  live.background = listed(live.background, e.tasks, now);
}

/** @param {string} text */
function parsed(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * The tasks listed now, each keeping when it was first listed, so a task that ends doesn’t pass its time to another.
 * Null when none is listed. O(tasks).
 * @param {{ tasks: Map<string, { since: number, name: string }> } | null} was @param {any[]} tasks @param {number} now
 */
function listed(was, tasks, now) {
  if (!tasks.length) return null;
  /** @type {Map<string, { since: number, name: string }>} */
  const next = new Map();
  for (const t of tasks) {
    const id = String(t?.task_id ?? t?.description ?? '');
    next.set(id, { since: was?.tasks.get(id)?.since ?? now, name: String(t?.description ?? t?.task_id ?? '') });
  }
  return { tasks: next };
}

/** The listed task waited on longest, or null. @param {import('./turns-shared.mjs').Live} live */
function oldest(live) {
  /** @type {{ since: number, name: string } | null} */
  let first = null;
  for (const t of live.background?.tasks.values() ?? []) if (!first || t.since < first.since) first = t;
  return first;
}

/** Whether a quiet turn has sent its result and waits on a listed task, each within the ceiling. @param {import('./turns-shared.mjs').Live} live @param {number} now */
export function waitingOnBackground(live, now) {
  const first = oldest(live);
  return live.resultSent && first !== null && now - first.since < QUIET.backgroundMax;
}

/** The stop text for a turn whose background task ran past the ceiling, or null if none is listed. @param {import('./turns-shared.mjs').Live} live */
export function backgroundStopText(live) {
  const first = oldest(live);
  if (!live.resultSent || !first) return null;
  const name = first.name.replace(UNPRINTABLE, ' ').replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim();
  const clipped = name.length > NAME_CHARS ? `${name.slice(0, partEnd(name, NAME_CHARS - 1))}…` : name;
  const hours = QUIET.backgroundMax / 3_600_000;
  return `Stopped: a background task (${clipped || 'unnamed'}) ran past ${hours} h with no output`;
}
