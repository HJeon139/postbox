// Ctrl-C, a kill or a closed terminal during the long parts of tools/signoff.mjs (#845): steps 3 and 4, which check
// out code in temporary worktrees, and --run-gate, which holds a heavy-suite slot. While one of them runs, the signal
// passes on to the command running then, as tools/heavy-lock.mjs passes it on, and the part runs no further command.
// Its own cleanup then runs (the worktree removed, the slot let go) before the script exits as the signal would have
// ended it. Outside those parts a signal ends the script at once, which leaves nothing of signoff’s own behind. A
// signal during the wait for a slot leaves tools/heavy-lock.mjs’s waiting file, .<pid>.json in the slot folder: that
// file is heavy-lock’s, and harmless, since a slot is checked by its holder’s pid.

/** The signals that stop a sign-off: Ctrl-C, a kill, and the terminal closing. */
export const SIGNALS = /** @type {const} */ (['SIGINT', 'SIGTERM', 'SIGHUP']);

/** The exit code of each, as a shell reports a process the signal ended: 128 plus its number. */
export const SIGNAL_EXIT = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

/**
 * A part’s record of a signal: the one that arrived, and how to pass it on to the command running now.
 * @typedef {{ signal?: string, kill?: (signal: string) => void }} Stop
 */

/**
 * Runs work, passing it the Stop its commands run with (exec in ./wait.mjs), and exits with the signal’s code once
 * work’s own cleanup has run, when one arrived.
 * @template T
 * @param {import('./deps.mjs').Deps} d @param {string} what the part, for the line it prints
 * @param {(stop: Stop) => Promise<T>} work
 * @returns {Promise<T>}
 */
export async function untilStopped(d, what, work) {
  /** @type {Stop} */
  const stop = {};
  const off = d.onSignal((signal) => {
    stop.signal = signal;
    d.log(`✖ ${signal}: stopping ${what}, then cleaning up`);
    stop.kill?.(signal);
  });
  try {
    return await work(stop);
  } finally {
    off();
    if (stop.signal) d.exit(SIGNAL_EXIT[/** @type {keyof typeof SIGNAL_EXIT} */ (stop.signal)] ?? 1);
  }
}
