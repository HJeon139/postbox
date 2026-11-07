// #872’s host-mode fault, stop-runner (tools/uat/hosts-watch.mjs does the faults): SIGSTOP to the runner of a host’s
// newest running turn, over the runner’s own ssh (tools/uat/hosts-ssh.mjs, SCRIPTS.stopRunner), so the host’s daemon
// finds it silent past the ceiling. host-hung-killed (tools/uat/triggers-hung.mjs) reads what it records.

import { onHost, SCRIPTS, UUID } from './hosts-ssh.mjs';

/**
 * #872: SIGSTOP to the runner of the host’s newest running turn (SCRIPTS.stopRunner), so it goes silent with its
 * process still there, as a hung one does: its daemon should kill it past the 60 s ceiling and end the turn
 * interrupted. Refused on a host that had Postbox before this run (--replace-host-install), as remove-postbox is: its
 * turns aren’t this run’s. Its process and turn, or null with no running turn there.
 * @param {{ label: string, destination: string, replaceInstall?: boolean }} h @param {typeof onHost} [run]
 * @returns {Promise<{ pid: string, turn: string }|null>}
 */
export async function stopRunner(h, run = onHost) {
  if (h.replaceInstall) throw new Error(`stop-runner is refused on ${h.label}: Postbox was there before this run (--replace-host-install).`);
  const r = await run(h.destination, SCRIPTS.stopRunner);
  const out = r.stdout.trim();
  if (r.code === 0 && out === 'none') return null;
  const m = /^turn (\S+)\nstopped (\d+)$/.exec(out);
  if (r.code !== 0 || !m || !UUID.test(m[1])) throw new Error(`Couldn’t stop the runner of ${h.label}’s newest turn: ${r.stderr || `exit ${r.code}`}`);
  return { pid: m[2], turn: m[1] };
}

/**
 * Stops a host’s runner (stopRunner) and records it. The host stays connected, so there’s no recovery to follow: the
 * turn’s end is the trigger’s to read (tools/uat/triggers-hung.mjs).
 * @param {import('./hosts-run.mjs').HostRun} hr @param {import('./hosts-run.mjs').RunHost} h @param {typeof onHost} run
 * @param {{ what: (label: string) => string, did: string, none: string }} words  its words in hosts-watch.mjs’s FAULT_WHAT
 */
export async function stopped(hr, h, run, words) {
  const at = Date.now();
  const s = await stopRunner(h, run);
  if (!s) {
    const shown = `There was no ${words.what(h.label)} to ${words.none}.`;
    hr.record.faults.push({ fault: 'stop-runner', label: h.label, at, states: [], recovered: null, shown });
    return `${shown} Nothing happened.`;
  }
  const shown = `${words.did} ${words.what(h.label)} (process ${s.pid}) with SIGSTOP, so it’s silent but still there. Its daemon should kill it after 60 s of silence, and Postbox should show the turn interrupted and resume it on its own.`;
  hr.record.faults.push({ fault: 'stop-runner', label: h.label, at, ...s, states: [], recovered: null, shown });
  hr.log(`fault stop-runner on ${h.label}: ${shown}`);
  return shown;
}
