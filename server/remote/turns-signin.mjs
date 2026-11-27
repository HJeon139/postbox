// A turn’s warning, before it starts on a host, that the host’s sign-in may have run out (the design, “Sign-in stays
// the host’s”): what turns-start.mjs’s prepare() shows before it hands the turn to the host.

import { BACKEND_NAMES } from '../../shared/agent-facts.mjs';
import { LOGIN_COMMANDS } from '../../shared/remote-protocol.mjs';
import { signInCheck } from './turns-resume.mjs';
import { abortError } from './turns-shared.mjs';

/** @typedef {import('./turns.mjs').RemoteTurns} RemoteTurns */

/**
 * Per host ID, the `at` of each harness’s signed-out answer already told, so a team of agents on one host hears that
 * answer once, not once per turn start (#1608). An unchanged answer keeps its `at` (hosts-signins.mjs), so a sign-out
 * is told again only once the host has said something else. A harness heard as anything else at a turn start drops its
 * own, so this holds at most one entry per harness of a host, until it answers otherwise or Postbox restarts.
 * @type {Map<string, Map<string, number>>}
 */
const told = new Map();

/**
 * A sign-in that’s run out shows before the turn, not at its first model request (the design, “Sign-in stays the
 * host’s”). It’s a warning, never a refusal: the check may be wrong, and the person decides. The start waits only for
 * signInCheck, as before #1608. It asks the host now whether the turn’s harness is signed in, without waiting, and
 * decides the warning when the answer comes (warnFrom): a sign-out names the command to run there, else a failed
 * signInCheck warns as before, so the two never give two notices.
 * @param {RemoteTurns} rts @param {any} turn @param {any} ctx @param {any} se @param {any} host
 */
export async function warnSignIn(rts, turn, ctx, se, host) {
  const check = await signInCheck(rts, turn.remote.hostId);
  if (ctx.signal.aborted) throw abortError();
  void signInsNow(rts, turn.remote.hostId)
    .then((now) => {
      if (!ctx.signal.aborted) warnFrom(rts, turn, se, host, ctx.persona?.backend, check, now);
    })
    .catch((/** @type {any} */ e) => console.error(`The sign-in warning before a turn on ${host.name} failed: ${e?.message}`));
}

/**
 * The host’s answer now, over the session the turn runs on, so a sign-in the person fixed since is heard (#1608); null
 * when there’s no asking or it fails, which warns of no sign-out. Never rejects: nothing waits on it to catch one.
 * @param {RemoteTurns} rts @param {string} hostId @returns {Promise<any>}
 */
function signInsNow(rts, hostId) {
  try {
    return Promise.resolve(rts.hosts?.signInsNow?.(hostId) ?? null).catch(() => null);
  } catch {
    return Promise.resolve(null); // an asking that throws as it’s called is one that failed: no sign-out heard
  }
}

/**
 * The one warning for a turn, once the host has answered: its harness signed out, the first time for that answer;
 * else a failed signInCheck.
 * @param {RemoteTurns} rts @param {any} turn @param {any} se @param {any} host @param {string | undefined} harness
 * @param {any} check @param {any} now
 */
function warnFrom(rts, turn, se, host, harness, check, now) {
  const hostId = turn.remote.hostId;
  if (signedOut(now, harness)) {
    if (wasTold(hostId, /** @type {string} */ (harness), now.at)) return;
    const name = BACKEND_NAMES[harness] ?? harness;
    const login = LOGIN_COMMANDS[/** @type {keyof typeof LOGIN_COMMANDS} */ (harness)]; // signedOut found it there
    rts.rt.threads.notify(
      'blocking',
      se,
      `${name} on ${host.name} isn’t signed in`,
      `${host.name} says ${name} there isn’t signed in, so @${se.handle}’s turns there may stop with “Sign-in needed”. Run “${login}” on ${host.name}, then carry on.`,
      turn.threadId,
    );
    noteTold(hostId, /** @type {string} */ (harness), now.at); // after notify, so one that throws is told again
    return;
  }
  if (harness && now) forgetTelling(hostId, harness); // an answer that says otherwise, not a failed asking
  if (check && !check.ok)
    rts.rt.threads.notify(
      'blocking',
      se,
      `Sign-in on ${host.name} may have run out`,
      `The host’s sign-in check failed${check.code === null ? '' : ` (exit code ${check.code})`}, so @${se.handle}’s turns there may stop with “Sign-in needed”. Sign in on the host, then carry on.`,
      turn.threadId,
    );
}

/** Whether this signed-out answer was told for the host’s harness. @param {string} hostId @param {string} harness @param {number} at */
function wasTold(hostId, harness, at) {
  return told.get(hostId)?.get(harness) === at;
}

/** Notes this signed-out answer told for the host’s harness. @param {string} hostId @param {string} harness @param {number} at */
function noteTold(hostId, harness, at) {
  told.set(hostId, (told.get(hostId) ?? new Map()).set(harness, at));
}

/** The harness isn’t signed out now, so its next sign-out is told again. @param {string} hostId @param {string} harness */
function forgetTelling(hostId, harness) {
  const byHarness = told.get(hostId);
  if (!byHarness?.delete(harness) || byHarness.size) return;
  told.delete(hostId);
}

/**
 * Whether the host’s answer says the harness isn’t signed in: only a plain signed-out counts, never unknown.
 * @param {any} signIns @param {string | undefined} harness
 */
function signedOut(signIns, harness) {
  if (!harness || !Object.hasOwn(LOGIN_COMMANDS, harness)) return false;
  return signIns?.harnesses?.some((/** @type {any} */ h) => h.name === harness && h.state === 'signed-out') === true;
}
