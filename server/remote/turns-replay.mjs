// While a remote turn’s stream is still being read up to where the host has it (#353, server/remote/turns.mjs, the
// header): after a restart its turn is attached again and read from the start, and after a reconnect it’s read on from
// where it stopped. The daemon sends `caught-up` once a read’s first pass has sent every line out.jsonl had. Until
// then the line of the call a permission prompt is for may still be on its way, however long the stream is, so the
// prompt’s wait for it (server/prompt-claim.mjs) starts only once the read has caught up. A daemon that hangs mid-read,
// or a link that keeps dropping, never says so, so that wait has a ceiling, PROMPT_REPLAY_WAIT_MS from when the prompt
// first came, past which the prompt is refused as one whose call never showed.

import { PROMPT_REPLAY_WAIT_MS } from '../../shared/limits.mjs';

/** @typedef {import('./turns-shared.mjs').Live} Live */

/** A read of the turn’s out.jsonl has started: the attach after a restart, or a `read` sent. @param {Live} live */
export function replaying(live) {
  if (live.replay) return;
  /** @type {() => void} */
  let end = () => {};
  const done = new Promise((resolve) => {
    end = () => resolve(undefined);
  });
  live.replay = { done, end };
}

/** The read has caught up, or the turn is over here: whatever waited on it goes on. @param {Live} live */
export function caughtUp(live) {
  const r = live.replay;
  live.replay = null;
  r?.end();
}

/** What a prompt’s wait for its call waits on before its bound starts, or null when nothing is being read. @param {Live} live */
export const replayed = (live) => live.replay?.done ?? null;

/**
 * The ceiling on a prompt’s wait for the replay: `at` settles PROMPT_REPLAY_WAIT_MS after the prompt `by` names first
 * came. The daemon sends a prompt again after every hello, and each resend of it shares its first’s ceiling, so a
 * reconnect that starts the read over never moves it. `release` once the prompt’s claim has settled.
 * @param {Live} live @param {unknown} by  the prompt’s claim (turns-prompts.mjs, byOf)
 * @returns {{ at: Promise<unknown>, release: () => void }}
 */
export function replayCeiling(live, by) {
  let c = live.ceilings.get(by);
  if (!c) {
    /** @type {any} */
    let timer;
    const at = new Promise((resolve) => {
      timer = setTimeout(resolve, PROMPT_REPLAY_WAIT_MS);
      timer.unref?.();
    });
    c = { at, timer, holds: 0 };
    live.ceilings.set(by, c);
  }
  const held = c;
  held.holds += 1;
  const release = () => {
    if (--held.holds) return;
    clearTimeout(held.timer);
    if (live.ceilings.get(by) === held) live.ceilings.delete(by);
  };
  return { at: held.at, release };
}
