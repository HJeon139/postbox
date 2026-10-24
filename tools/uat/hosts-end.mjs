// The end of a host-mode run (#120, “Done when”), checked over the runner’s own ssh (tools/uat/hosts-ssh.mjs):
// 1. Each host’s ~/.postbox-remote/turns, against the turns Postbox recorded there (host-turns-listed).
// 2. After the idle timeout, nothing of Postbox runs there: Postbox closes its connection IDLE_GRACE_MS after nothing
//    needs the host, and the daemon exits idleTimeout after that. Set the shortest, 1 min, with
//    --host-setting hostN.idleTimeout=1min; a host left at more than 10 min isn’t waited for, and says so.
// 3. Remove through the UI, accepting its confirm (tools/uat/driver-hosts.mjs), then no ~/.postbox-remote there and
//    nothing of Postbox running. What the run put there itself (~/postbox-uat: the project’s folder, P0’s launcher)
//    goes too.
// Each step records what it found, and a failure in one doesn’t skip the rest.

import { IDLE_GRACE_MS } from '../../server/remote/hosts-links.mjs';
import { sleep } from '../cdp.mjs';
import { closeAll, removeHost } from './driver-hosts.mjs';
import { saveHosts } from './hosts-run.mjs';
import { linesOf, onHost, processesOf, SCRIPTS, UUID } from './hosts-ssh.mjs';

/** @typedef {import('./hosts-run.mjs').HostRun} HostRun @typedef {import('./hosts-run.mjs').RunHost} RunHost */

const DEFAULT_IDLE_MS = 30 * 60_000;
const LONGEST_WAIT_MS = 10 * 60_000;

/** What of Postbox runs on the host now, or null when ssh couldn’t say. @param {RunHost} h */
async function running(h) {
  const r = await onHost(h.destination, SCRIPTS.processes);
  return r.code === 0 ? processesOf(r.stdout) : null;
}

/** Polls until nothing of Postbox runs on the host, or the deadline. @param {RunHost} h @param {number} ms */
async function untilNothing(h, ms) {
  const start = Date.now();
  let left = await running(h);
  while (left?.length && Date.now() - start < ms) {
    await sleep(20_000);
    left = await running(h);
  }
  return { left: left ?? ['(the runner’s ssh couldn’t list the processes)'], waited: Date.now() - start };
}

/** Waits out the host’s idle timeout. @param {RunHost} h */
async function idle(h) {
  const timeout = h.settings.idleTimeout ?? DEFAULT_IDLE_MS;
  if (timeout > LONGEST_WAIT_MS)
    return {
      skipped: `Its idleTimeout is ${Math.round(timeout / 60_000)} min, longer than a run waits (${LONGEST_WAIT_MS / 60_000} min). Pass --host-setting ${h.label}.idleTimeout=1min to check it.`,
    };
  return untilNothing(h, IDLE_GRACE_MS + timeout + 60_000);
}

/** Removes the host through the UI, then looks there. @param {HostRun} hr @param {RunHost} h */
async function remove(hr, h) {
  try {
    // A dialog left open (a failed install’s confirm, say) would take the click meant for Remove….
    await closeAll(hr.kit);
    const confirm = await removeHost(hr.kit, /** @type {string} */ (h.id));
    const there = (await onHost(h.destination, SCRIPTS.removed)).stdout.trim();
    const { left } = await untilNothing(h, 30_000);
    return { confirm, exists: there !== 'absent', left };
  } catch (e) {
    return { error: e.message };
  } finally {
    await closeAll(hr.kit).catch(() => {});
  }
}

/**
 * The end-of-run checks, over every host the run set up. The record says ended once they’ve run, so the checks that
 * read it (tools/uat/checks-remote.mjs) say what they couldn’t judge.
 * @param {HostRun} hr
 */
export async function finish(hr) {
  const set = hr.hosts.filter((h) => h.id);
  hr.record.listed = {};
  hr.record.idle = {};
  hr.record.removed = {};
  for (const h of set) {
    const r = await onHost(h.destination, SCRIPTS.turns);
    hr.record.listed[h.label] = linesOf(r.stdout).filter((t) => UUID.test(t));
  }
  hr.log(
    `Waiting out the hosts’ idle timeout: ${set.map((h) => `${h.label} ${Math.round((h.settings.idleTimeout ?? DEFAULT_IDLE_MS) / 1000)} s`).join(', ')}, after Postbox’s own ${IDLE_GRACE_MS / 1000} s.`,
  );
  const idled = await Promise.all(set.map((h) => idle(h)));
  set.forEach((h, i) => {
    hr.record.idle[h.label] = idled[i];
    hr.log(
      `${h.label} after its idle timeout: ${'skipped' in idled[i] ? idled[i].skipped : idled[i].left.length ? `still running: ${idled[i].left.join('; ')}` : 'nothing of Postbox runs'}.`,
    );
  });
  for (const h of set) {
    hr.record.removed[h.label] = await remove(hr, h);
    hr.log(`${h.label} removed: ${JSON.stringify(hr.record.removed[h.label])}`);
  }
  for (const h of set) await onHost(h.destination, SCRIPTS.cleanUp);
  hr.record.ended = true;
}

/** The end-of-run checks, then the record saved. @param {HostRun} hr @param {string} dir */
export async function endHosts(hr, dir) {
  await finish(hr);
  await saveHosts(hr, dir);
}

/**
 * A run that stopped before its end: removes what it installed, through the UI, so no host keeps Postbox. Says what
 * to run by hand for one it couldn’t.
 * @param {HostRun} hr
 */
export async function cleanUp(hr) {
  if (hr.record.ended || !hr.kit) return;
  for (const h of hr.hosts.filter((x) => x.id)) {
    const r = await remove(hr, h);
    await onHost(h.destination, SCRIPTS.cleanUp);
    hr.log(
      r.error
        ? `Couldn’t remove Postbox from ${h.label}: ${r.error} Remove it there by hand (tests/uat/remote-hosts.md, “Clean up”).`
        : `Removed Postbox from ${h.label}.`,
    );
  }
}
