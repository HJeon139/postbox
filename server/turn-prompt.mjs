// What each turn sent its agent, recorded only in UAT recording mode (POSTBOX_UAT_RECORD=1, #1528): each adapter
// calls ctx.prompt once its backend has the prompt, with the system text Postbox gives it (the guide) and the prompt’s
// exact text. They go to prompts.jsonl in the data folder, one JSON object a line, and never to the store: not the
// event log, the stream, the backlog or the state a page reads. With the mode off a turn has no ctx.prompt, so nothing
// is recorded and no adapter does anything more. The rows are described in tests/uat/e2e/README.md, in what a run holds.

import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { uatRecording } from './uat-mode.mjs';

export const PROMPTS_FILE = 'prompts.jsonl';

/** Where the recording goes, or null with the mode off. @param {string} dataDir @param {Record<string, string | undefined>} env */
export const promptsFileFor = (dataDir, env = process.env) => (uatRecording(env) ? join(dataDir, PROMPTS_FILE) : null);

/**
 * The guides each runtime has recorded since it started, by session and hash: once per session, so each
 * conversation’s record has its agent’s guide however many conversations share it. A restart records them again.
 * @type {WeakMap<any, Set<string>>}
 */
const recorded = new WeakMap();

/**
 * A turn’s ctx.prompt, only in recording mode: `{ prompt }` for adapterContext to spread, or nothing.
 * @param {any} rt @param {any} turn @param {() => number} [now]
 */
export function promptHook(rt, turn, now = Date.now) {
  const file = rt.config?.promptsFile;
  return typeof file === 'string' ? { prompt: (/** @type {any} */ p) => recordTurnPrompt(rt, file, turn, p, now) } : {};
}

/**
 * A turn’s prompt, once its backend has it: `guide` when the adapter has it (an adapter that sets it once per turn
 * passes it alone, then each prompt with only its text), and `text`, the prompt itself. Appended synchronously, as the
 * adapters’ stream recordings are (server/adapters/setup.mjs’s recorderFor), so the rows keep the order they came in.
 * @param {any} rt @param {string} file @param {any} turn @param {{ guide?: string | null, text?: string }} p @param {() => number} now
 */
function recordTurnPrompt(rt, file, turn, { guide, text }, now) {
  const rows = [];
  if (typeof guide === 'string') {
    const sha = createHash('sha256').update(guide).digest('hex');
    const mine = recorded.get(rt) ?? new Set();
    recorded.set(rt, mine);
    const key = `${turn.sessionId}\u0000${sha}`;
    if (!mine.has(key)) rows.push({ type: 'guide', sessionId: turn.sessionId, sha, text: guide, at: now() });
    mine.add(key);
    turn.guideSha = sha;
  }
  if (typeof text === 'string')
    rows.push({ type: 'prompt', sessionId: turn.sessionId, turnId: turn.id, threadId: turn.threadId, guideSha: turn.guideSha ?? null, text, at: now() });
  if (!rows.length) return;
  try {
    appendFileSync(file, rows.map((r) => `${JSON.stringify(r)}\n`).join(''));
  } catch (e) {
    // A recording that can’t be written never stops the turn: the run’s record is short, and says so here.
    console.error(`Postbox couldn’t record a turn’s prompt in ${file}: ${e.message}`);
  }
}
