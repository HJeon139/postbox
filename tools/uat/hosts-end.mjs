// The end of a host-mode run (#120, “Done when”), checked over the runner’s own ssh (tools/uat/hosts-ssh.mjs):
// 1. Each host’s ~/.postbox-remote/turns, against the turns Postbox recorded there (host-turns-listed).
// 2. After the idle timeout, nothing of Postbox runs there: Postbox closes its connection IDLE_GRACE_MS after nothing
//    needs the host, and the daemon exits idleTimeout after that. Set the shortest, 1 min, with
//    --host-setting hostN.idleTimeout=1min; a host left at more than 10 min isn’t waited for, and says so.
// 3. Remove through the UI, accepting its confirm (tools/uat/driver-hosts.mjs), then no ~/.postbox-remote there and
//    nothing of Postbox running. What the run put there itself, its own ~/postbox-uat/<run> (the project’s folder,
//    P0’s launcher), goes too, and ~/postbox-uat only if the run made it and nothing else is in it.
// Each step records what it found, and a failure in one doesn’t skip the rest. What couldn’t be measured (ssh
// failed, or pgrep did) is recorded as that, never as nothing running. A run stopped early (Ctrl-C, or an error)
// does step 3 in cleanUp, once, after any end-of-run checks already going.

import { IDLE_GRACE_MS } from '../../server/remote/hosts-links.mjs';
import { sleep } from '../cdp.mjs';
import { closeAll, removeHost } from './driver-hosts.mjs';
import { saveHosts } from './hosts-run.mjs';
import { cleanUpScript, linesOf, measureOn, onHost, processesOf, SCRIPTS, UUID } from './hosts-ssh.mjs';

/** @typedef {import('./hosts-run.mjs').HostRun} HostRun @typedef {import('./hosts-run.mjs').RunHost} RunHost */

const DEFAULT_IDLE_MS = 30 * 60_000;
const LONGEST_WAIT_MS = 10 * 60_000;

/** What of Postbox runs on the host now, or null and why when it couldn’t be listed. @param {RunHost} h */
async function running(h) {
  const { out, why } = await measureOn(h.destination, SCRIPTS.processes);
  return { left: out === null ? null : processesOf(out), why };
}

/**
 * Polls until nothing of Postbox runs on the host, or the deadline. left is null, with unmeasured, when the last
 * look couldn’t list the processes. @param {RunHost} h @param {number} ms
 */
async function untilNothing(h, ms) {
  const start = Date.now();
  let now = await running(h);
  while ((now.left === null || now.left.length) && Date.now() - start < ms) {
    await sleep(20_000);
    now = await running(h);
  }
  return { left: now.left, waited: Date.now() - start, ...(now.left === null ? { unmeasured: now.why } : {}) };
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
    const { left, unmeasured } = await untilNothing(h, 30_000);
    return { confirm, exists: there !== 'absent', left, ...(unmeasured ? { unmeasured } : {}) };
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
    hr.record.listed[h.label] = r.code === 0 ? linesOf(r.stdout).filter((t) => UUID.test(t)) : null;
  }
  hr.log(
    `Waiting out the hosts’ idle timeout: ${set.map((h) => `${h.label} ${Math.round((h.settings.idleTimeout ?? DEFAULT_IDLE_MS) / 1000)} s`).join(', ')}, after Postbox’s own ${IDLE_GRACE_MS / 1000} s.`,
  );
  const idled = await Promise.all(set.map((h) => idle(h)));
  set.forEach((h, i) => {
    hr.record.idle[h.label] = idled[i];
    hr.log(
      `${h.label} after its idle timeout: ${'skipped' in idled[i] ? idled[i].skipped : idled[i].left === null ? `couldn’t list what runs: ${idled[i].unmeasured}` : idled[i].left.length ? `still running: ${idled[i].left.join('; ')}` : 'nothing of Postbox runs'}.`,
    );
  });
  for (const h of set) {
    hr.record.removed[h.label] = await remove(hr, h);
    hr.log(`${h.label} removed: ${JSON.stringify(hr.record.removed[h.label])}`);
  }
  for (const h of set) await removeRunFolder(hr, h);
  hr.record.ended = true;
}

/**
 * Removes the run’s own folder from a host, if the run made it, and says what to run by hand when it can’t.
 * @param {HostRun} hr @param {RunHost} h @param {typeof onHost} [run]
 */
async function removeRunFolder(hr, h, run = onHost) {
  if (!h.made) return;
  const r = await run(h.destination, cleanUpScript(hr.stamp, h.made));
  if (r.code === 0) h.made = null;
  else
    hr.log(
      `Couldn’t remove ~/postbox-uat/${hr.stamp} from ${h.label}: ${(r.stderr || `exit ${r.code}`).replace(/\.$/, '')}. On ${h.destination}, run: rm -rf ~/postbox-uat/${hr.stamp}`,
    );
}

/** Whether a Remove’s record shows Postbox gone from the host: no error, no ~/.postbox-remote, nothing of it running. */
const removedThere = (r) => !!r && !r.error && r.exists === false && Array.isArray(r.left) && !r.left.length;

/** Why a Remove’s record doesn’t show Postbox gone. */
const notGone = (r) =>
  !r
    ? 'it was never removed'
    : (r.error ??
      (r.exists
        ? '~/.postbox-remote was still there after Remove'
        : r.left === null
          ? `what runs there couldn’t be listed (${r.unmeasured})`
          : `still running: ${r.left.join('; ')}`));

/** The end-of-run checks, then the record saved. @param {HostRun} hr @param {string} dir */
export async function endHosts(hr, dir) {
  hr.ending = finish(hr);
  await hr.ending;
  await saveHosts(hr, dir);
}

/**
 * The run’s last word on its hosts, by an error, by Ctrl-C or after the end-of-run checks: every host whose Remove
 * wasn’t confirmed (never tried, or it failed) is removed through the UI, and the run’s own folder there too. Once
 * only, however often it’s called, and after any setup or end-of-run checks already going. A Remove that went through
 * Postbox but left something on the host can’t be tried again from here, since the host is gone from Postbox: then,
 * and for a Remove that failed again, it says what to run by hand.
 * @param {HostRun} hr @param {{ removeOne?: typeof remove, run?: typeof onHost }} [o]
 */
export function cleanUp(hr, { removeOne = remove, run = onHost } = {}) {
  hr.cleaning ??= (async () => {
    await hr.starting?.catch(() => {});
    await hr.ending?.catch(() => {});
    hr.record.cleanup = {};
    for (const h of hr.hosts.filter((x) => x.id || x.made)) {
      let r = hr.record.removed?.[h.label];
      if (h.id && hr.kit && (!r || r.error)) {
        r = await removeOne(hr, h);
        hr.record.cleanup[h.label] = r;
      }
      await removeRunFolder(hr, h, run);
      if (!h.id) continue;
      if (!removedThere(r))
        hr.log(
          `Postbox may still be on ${h.label}: ${notGone(r).replace(/\.$/, '')}. On ${h.destination}, stop what pgrep -u "$USER" -fa '[.]postbox-remote' lists, then run: rm -rf ~/.postbox-remote (tests/uat/remote-hosts.md, “Clean up”).`,
        );
      else if (hr.record.cleanup[h.label]) hr.log(`Removed Postbox from ${h.label}.`);
    }
  })();
  return hr.cleaning;
}
