// How a UAT run stops (tools/uat-run.mjs; #120). A host-mode run that stops early has hosts to clean up: Postbox
// installed there, and turns that go on running, and spending, until something removes them. So the runner owns
// SIGINT, SIGTERM and SIGHUP, not its parts: the first one runs the run’s own stop (its hosts removed through the
// page, then the page and Postbox closed) and exits 130 once that’s done; another one exits at once, saying what’s
// left to clean up by hand. Postbox and Chromium run in process groups of their own (tools/uat/postbox.mjs,
// tools/browser.mjs), so a terminal’s Ctrl-C, which reaches its whole foreground group, leaves them up for the cleanup.

import { cleanUp } from './hosts-end.mjs';

const SIGNALS = /** @type {const} */ (['SIGINT', 'SIGTERM', 'SIGHUP']);

/**
 * The run’s stop, once however often it’s called: by the end of the run, by an error, or by a signal. It reads run
 * when it’s called, so a signal before the page or the hosts exist stops only what does; the exit then stops
 * Postbox and Chrome in any case.
 * @param {{ hr?: import('./hosts-run.mjs').HostRun | null, history?: { close: () => void }, page?: { close: () => Promise<void> },
 *   postbox?: { kill: () => Promise<void> }, log: (line: string) => void }} run
 * @returns {() => Promise<void>}
 */
export function runStop(run) {
  /** @type {Promise<void> | undefined} */
  let done;
  return () => {
    done ??= (async () => {
      if (run.hr) await cleanUp(run.hr).catch((e) => run.log(`Couldn’t clean the hosts up: ${e.message}`));
      run.history?.close();
      await run.page?.close().catch(() => {});
      await run.postbox?.kill();
    })();
    return done;
  };
}

/**
 * Runs stop on the first of SIGINT, SIGTERM or SIGHUP, then exits 130; exits 130 at once on another. process.exitCode
 * is 130 from the first, so a run that ends meanwhile, by an error or not, still exits as stopped.
 * @param {() => Promise<void>} stop @param {{ log: (line: string) => void, exit?: (code: number) => void }} o
 * @returns {{ readonly stopping: boolean, off: () => void }}
 */
export function onStopSignal(stop, { log, exit = (code) => process.exit(code) }) {
  let stopping = false;
  /** @param {NodeJS.Signals} sig */
  const handler = (sig) => {
    if (stopping) {
      log(`${sig} again: exiting before the cleanup finished. Clean each host up by hand (tests/uat/remote-hosts.md, section 7).`);
      exit(130);
      return;
    }
    stopping = true;
    process.exitCode = 130;
    log(`${sig}: stopping the run, once its hosts are cleaned up. ${sig === 'SIGINT' ? 'Ctrl-C again exits' : 'Another signal exits'} at once.`);
    stop()
      .catch((e) => log(`The run’s stop failed: ${e.message}`))
      .finally(() => exit(130));
  };
  for (const sig of SIGNALS) process.on(sig, handler);
  return {
    get stopping() {
      return stopping;
    },
    off: () => {
      for (const sig of SIGNALS) process.off(sig, handler);
    },
  };
}
