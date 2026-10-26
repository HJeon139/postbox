// The person’s hosts (#120; architecture.md, “Remote hosts”): adding one, renaming it or changing its settings,
// removing it, and a project’s folder on one. The hosts are in the state (s.hosts, 'host' events); the runtime
// (server/runtime.mjs) calls these with itself first, and its host manager (rt.hosts) reaches each host’s daemon.

import { HOST_ENFORCED } from '../../shared/remote-protocol.mjs';
import { checkDestination, checkHostPath, checkHostSettings } from '../../shared/remote-settings.mjs';
import { httpError } from '../helpers.mjs';
import { newId } from '../store.mjs';

/**
 * How long removing a host waits for the turns it stopped there to end before it drops the link (#120): the daemon’s
 * grace period between SIGINT and SIGKILL is 10 s, and the stop and its answer cross the network.
 */
const REMOVE_HOST_WAIT_MS = 15000;

/** @param {any} rt @param {string} id @returns {import('../../shared/remote-settings.mjs').Host} */
export function host(rt, id) {
  const h = rt.s.hosts?.[id];
  if (!h) throw httpError(404, 'That host doesn’t exist. It may have been removed.');
  return h;
}

/** A host by its SSH destination, the one the person sees. @param {any} rt @param {string} name @param {string} [except] */
function hostNamed(rt, name, except) {
  return Object.values(rt.s.hosts ?? {}).find((/** @type {any} */ h) => h.id !== except && h.name === name) ?? null;
}

/**
 * Adds a host: its SSH destination and any settings that differ from the defaults.
 * @param {any} rt @param {{ name?: unknown, settings?: unknown }} opts
 */
export function addHost(rt, { name, settings } = {}) {
  const dest = checked(checkDestination(name));
  if (hostNamed(rt, dest)) throw httpError(409, `${dest} is already a host.`);
  const h = { id: newId('ho'), name: dest, settings: checked(checkHostSettings(settings)), createdAt: Date.now() };
  rt.store.emit('host', h);
  return h;
}

/**
 * Renames a host or changes some of its settings; settings not given keep their values. A change to one the daemon
 * enforces (HOST_ENFORCED) reaches a connected host at once: its link opens a new session, whose hello sends it.
 * @param {any} rt @param {string} id @param {{ name?: unknown, settings?: unknown }} patch
 */
export function updateHost(rt, id, { name, settings } = {}) {
  const h = host(rt, id);
  const dest = name === undefined ? h.name : checked(checkDestination(name));
  if (hostNamed(rt, dest, id)) throw httpError(409, `${dest} is already a host.`);
  // A new destination is another machine, as far as Postbox knows: a turn there now would go on there while new
  // ones went to the new one, and a resume would look for its session on the wrong machine.
  if (dest !== h.name && rt.remote.busyOn(id))
    throw httpError(
      409,
      `${h.name} can’t be renamed while agents’ turns run there or wait to go on there: they’d carry on on ${h.name} while new ones went to ${dest}. Stop them or let them finish, then rename it.`,
    );
  const next = { ...h, name: dest, settings: checked(checkHostSettings(settings ?? {}, h.settings)) };
  rt.store.emit('host', next);
  const enforced = HOST_ENFORCED.some((k) => JSON.stringify(h.settings?.[k]) !== JSON.stringify(next.settings?.[k]));
  // Renamed: the manager drops the old link now, if nothing needs it, and the next use dials the new destination.
  if (dest !== h.name) rt.hosts?.refresh(id).catch((/** @type {any} */ e) => console.error(`Postbox couldn’t close its link to ${h.name}: ${e?.message ?? e}`));
  else if (enforced && rt.hosts?.status(id)?.state === 'connected')
    rt.hosts.refresh(id).catch((/** @type {any} */ e) => console.error(`Postbox couldn’t send ${dest} its new settings: ${e?.message ?? e}`));
  return next;
}

/**
 * Removes a host, and every project’s folder on it. Its turns stop first, each as Stop stops it, through the daemon,
 * and Postbox waits up to waitMs for them to end. A turn that may still run there (its link gave up, or the stop
 * hasn’t reached it) keeps the host: Postbox connects to ask, and until the daemon confirms each is over, the
 * removal is refused (409) and the host’s settings and token stay, so the stops can still be delivered. So is one
 * whose token is gone from this computer: nothing can reach the host to stop them, which isn’t a sign they stopped,
 * so installing again is the way to stop them. Then Postbox removes itself from the host (the manager’s
 * removeFromHost: the daemon stops anything still running there, deletes ~/.postbox-remote and says `removed`), and
 * only then does the manager forget the link and its token, so nothing holds a connection to a host Postbox no longer
 * knows. Until the host confirms, the removal is refused (409, with the reason and the next step) and the settings and
 * token stay: without the token, Postbox could never reach what it left there. One with no token here and nothing
 * running there is removed here alone, since Postbox can’t reach anything of its own there.
 * Agents placed on it keep their placement and can’t start a turn there until they’re moved.
 * @param {any} rt @param {string} id @param {{ waitMs?: number }} [opts]
 */
export async function removeHost(rt, id, { waitMs = REMOVE_HOST_WAIT_MS } = {}) {
  const h = host(rt, id);
  const until = Date.now() + waitMs;
  const { stopped, given } = await stopTurnsOn(rt, id, waitMs);
  await refuseWhileRunning(rt, h, id, until);
  if (rt.hosts) await leaveHost(rt, h, id);
  // It may have been removed meanwhile, by a second click.
  if (!rt.s.hosts?.[id]) return { ok: true, stopped: stopped.length + given };
  for (const p of Object.values(rt.s.projects)) {
    if (!p.hostFolders || !Object.hasOwn(p.hostFolders, id)) continue;
    const { [id]: _gone, ...rest } = p.hostFolders;
    rt.store.emit('project', { ...p, hostFolders: rest });
  }
  rt.store.emit('host', { id, removed: true });
  return { ok: true, stopped: stopped.length + given };
}

/**
 * Stops the turns on a host, and waits up to waitMs for those it stopped to end: agents placed on it, and sessions
 * with a turn there (one that started before its agent moved, or one waiting to be attached again after a restart,
 * which no Stop reaches, and which is given up instead).
 * @param {any} rt @param {string} id @param {number} waitMs
 */
async function stopTurnsOn(rt, id, waitMs) {
  const stopped = [];
  let given = 0;
  const on = new Set(rt.remote.sessionsOn(id));
  for (const se of Object.values(rt.s.sessions)) if (rt.persona(se.personaId)?.remote?.hostId === id || se.remoteTurn?.hostId === id) on.add(se.id);
  for (const sessionId of on) {
    // A turn already stopping is waited for too.
    if (rt.stop(sessionId, { silent: true }) || rt.exiting.has(sessionId)) stopped.push(rt.exiting.get(sessionId)?.turn.exited);
    else if (rt.remote.cancel(sessionId)) given++;
  }
  if (stopped.length) {
    /** @type {NodeJS.Timeout|undefined} */
    let timer;
    const late = new Promise((r) => {
      timer = setTimeout(r, waitMs);
    });
    await Promise.race([Promise.all(stopped), late]);
    clearTimeout(timer);
  }
  return { stopped, given };
}

/**
 * The removal is refused while the daemon hasn’t confirmed that each turn Postbox stopped there is over.
 * @param {any} rt @param {any} h @param {string} id @param {number} until
 */
async function refuseWhileRunning(rt, h, id, until) {
  const { left, noToken } = await rt.remote.confirmStops(id, Math.max(0, until - Date.now()));
  if (left.length && noToken) {
    const names = [
      ...new Set(
        left.map((/** @type {string} */ t) => rt.s.sessions[rt.remote.stopping.get(t)?.sessionId ?? '']?.handle).map((x) => (x ? `@${x}` : 'an agent')),
      ),
    ];
    throw httpError(
      409,
      `${h.name}’s token isn’t on this computer any more, so Postbox can’t reach it to stop ${left.length} running ${left.length === 1 ? 'turn' : 'turns'}: ${names.join(', ')}. Install Postbox on ${h.name} again to stop them, then remove it.`,
    );
  }
  if (left.length) {
    const reached = rt.hosts?.status(id)?.state === 'connected';
    const turns = left.length === 1 ? 'a turn' : `${left.length} turns`;
    throw httpError(
      409,
      reached
        ? `${h.name} hasn’t confirmed that ${turns} there stopped, so Postbox keeps the host until it does. Try again in a moment.`
        : `${h.name} can’t be reached, so its running turns can’t be stopped; Postbox keeps the host until they can be. They’re stopped when it’s back, and then you can remove it.`,
    );
  }
}

/**
 * Postbox removes itself from the host, then forgets the link and its token.
 * @param {any} rt @param {any} h @param {string} id
 */
async function leaveHost(rt, h, id) {
  try {
    await rt.hosts.removeFromHost(id);
  } catch (e) {
    // No token here: nothing of Postbox’s there can be reached. No host: a second click removed it meanwhile.
    if (e?.code !== 'not-installed' && e?.code !== 'no-host')
      throw Object.assign(httpError(409, `${String(e?.message ?? e)} Postbox keeps ${h.name} and its token here until it can remove itself there.`), {
        code: e?.kind ?? e?.code ?? 'failed',
        next: e?.next ?? null,
      });
  }
  await rt.hosts.forget(id);
}

/**
 * Sets a project’s folder on a host, an absolute path there; null clears it, and its agents work in
 * ~/postbox-work/<handle> on that host instead (the design, “The adapters stay”).
 * @param {any} rt @param {string} projectId @param {string} hostId @param {unknown} folder
 */
export function setProjectHostFolder(rt, projectId, hostId, folder) {
  const p = rt.s.projects[projectId];
  if (!p) throw httpError(404, 'That project doesn’t exist.');
  const h = host(rt, hostId);
  const { [hostId]: _old, ...rest } = p.hostFolders ?? {};
  const hostFolders = folder === null ? rest : { ...rest, [hostId]: checked(checkHostPath(folder, `The project’s folder on ${h.name}`)) };
  const next = { ...p, hostFolders };
  rt.store.emit('project', next);
  return next;
}

/** A check’s value, or its refusal as a 422. @param {import('../../shared/remote-settings.mjs').Checked} r */
function checked(r) {
  if (!r.ok) throw httpError(422, r.error);
  return r.value;
}
