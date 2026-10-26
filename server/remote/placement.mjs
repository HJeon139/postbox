// Where an agent runs (#120; architecture.md, “Remote hosts”): on this computer, or on one of the person’s hosts
// (persona.remote = { hostId }). Which backends run here, which can run on a host, and the checks a persona’s
// placement passes when it’s made or changed. The runtime (server/runtime.mjs) calls these with itself first.

import { httpError } from '../helpers.mjs';

/** A harness’s name for the person, and the host setting that names its path (shared/remote-settings.mjs). */
const HARNESS_LABELS = /** @type {Record<string, [string, string]>} */ ({
  'claude-code': ['Claude Code', 'claudePath'],
  'kiro-cli': ['Kiro CLI', 'kiroPath'],
  codex: ['Codex', 'codexPath'],
});

/**
 * The backends that run on this computer: every registered one but those registered to run only on a host (the
 * registry’s here: false). Claude Code, Kiro CLI and Codex are registered that way when their CLI isn’t found
 * (server/index.mjs), since an agent can still run them on a host.
 * @param {any} rt
 */
export function localBackends(rt) {
  return rt.adapters.names().filter((n) => rt.adapters.runsHere(n));
}

/** @param {any} rt @param {string} backend */
export function runsHere(rt, backend) {
  return rt.adapters.runsHere(backend);
}

/** Why a backend can’t run on this computer, and what can. @param {any} rt @param {string} backend */
export function notHere(rt, backend) {
  const elsewhere = rt.adapters.names().includes(backend) && rt.adapters.get(backend).capabilities?.remote;
  return `“${backend}” isn’t available on this computer. Available: ${localBackends(rt).join(', ')}.${elsewhere ? ' It can run on one of your hosts: choose one for this agent.' : ''} See README, “Run real agents”.`;
}

/**
 * Where a persona runs: null for this computer, or { hostId } for a host Postbox knows. Only a backend that says how
 * it runs remotely (capabilities.remote: Claude Code, Kiro CLI and Codex) can run on a host.
 * @param {any} rt @param {unknown} remote @param {string} backend  a registered backend @returns {{ hostId: string } | null}
 */
export function placement(rt, remote, backend) {
  if (remote === null || remote === undefined) return null;
  const r = /** @type {Record<string, unknown>} */ (remote);
  if (typeof remote !== 'object' || Array.isArray(remote) || Object.keys(r).some((k) => k !== 'hostId'))
    throw httpError(422, 'Where an agent runs is null, for this computer, or { hostId } for one of your hosts.');
  const h = typeof r.hostId === 'string' && Object.hasOwn(rt.s.hosts ?? {}, r.hostId) ? rt.s.hosts[r.hostId] : null;
  if (!h) throw httpError(422, 'That host doesn’t exist; it may have been removed. Pick one of your hosts, or run the agent on this computer.');
  if (!rt.adapters.names().includes(backend)) throw httpError(422, `“${backend}” isn’t available in this Postbox, so it can’t run on ${h.name} either.`);
  if (!rt.adapters.get(backend).capabilities?.remote) {
    const can = rt.adapters.names().filter((n) => rt.adapters.get(n).capabilities?.remote);
    throw httpError(
      422,
      `“${backend}” runs only on this computer, so this agent can’t run on ${h.name}. ${can.length ? `Backends here that can run on a host: ${can.join(', ')}.` : 'Claude Code, Kiro CLI and Codex can run on a host, and none of them is on this computer.'}`,
    );
  }
  checkHarness(rt, h, backend);
  return { hostId: h.id };
}

/**
 * The host’s last welcome says which harnesses its daemon found. Not known yet, the turn’s start says.
 * @param {any} rt @param {any} h @param {string} backend
 */
function checkHarness(rt, h, backend) {
  const w = rt.hosts?.status(h.id)?.welcome;
  if (!Array.isArray(w?.harnesses)) return;
  const found = w.harnesses.find((/** @type {any} */ x) => x?.name === backend);
  if (found?.path) return;
  const [label, setting] = HARNESS_LABELS[backend] ?? [backend, 'its path'];
  const looked = found?.looked?.length ? ` Postbox’s daemon looked in ${found.looked.join(', ')}.` : '';
  throw httpError(
    422,
    `${label} isn’t installed on ${h.name}, so this agent can’t run there.${looked} Install it there, or set ${setting} in the host’s settings.`,
  );
}

/**
 * Refuses a turn here whose backend was registered for hosts only (its CLI isn’t here): an agent placed here since
 * its backend’s CLI went. A turn on a host doesn’t call this.
 * @param {any} rt @param {any} se @param {any} persona
 */
export function refuseHere(rt, se, persona) {
  if (runsHere(rt, persona?.backend ?? 'mock')) return;
  const text = `@${se.handle}’s turn didn’t start: ${notHere(rt, persona?.backend ?? 'mock')}`;
  throw Object.assign(new Error(text), { userMessage: text });
}

/**
 * Where `!` commands run for an agent on a host (#67): on this computer even so, in the project’s folder here, else
 * the workspace of its own the agent would have here, never a path on the host; `host` names the host.
 * @param {any} rt @param {any} persona @param {any} project @param {any} adapter
 * @returns {Promise<{ folder: string|null, host: string }>}
 */
export async function hereFolder(rt, persona, project, adapter) {
  const host = rt.s.hosts?.[persona.remote.hostId]?.name ?? 'its host';
  // Its own folder is left out: it’s where the agent works, and that’s on the host.
  const here = { ...persona, folder: '' };
  return { folder: (adapter?.folderFor ? await adapter.folderFor(here, project) : project?.folder) || null, host };
}

/**
 * A persona’s patch with where it runs checked (#120): when that changes, and when its backend does, since only some
 * backends run on a host. On this computer, its backend’s CLI must be here (one that runs only on a host is
 * registered all the same).
 * @param {any} rt @param {string} id @param {any} p  the persona as it is @param {any} patch
 */
export function placedPatch(rt, id, p, patch) {
  if (patch.remote !== undefined || (patch.backend !== undefined && p.remote)) {
    const remote = placement(rt, patch.remote === undefined ? p.remote : patch.remote, patch.backend ?? p.backend);
    if ((remote?.hostId ?? null) !== (p.remote?.hostId ?? null)) {
      const busy = Object.values(rt.s.sessions).some((se) => se.personaId === id && (rt.turns.has(se.id) || rt.exiting.has(se.id)));
      if (busy) throw httpError(409, `@${p.handle} is in the middle of a turn. Stop it or let it finish, then move it.`);
    }
    patch = { ...patch, remote };
  }
  if ((patch.backend !== undefined || patch.remote !== undefined) && !(patch.remote === undefined ? p.remote : patch.remote)) {
    const backend = patch.backend ?? p.backend;
    if (!runsHere(rt, backend)) throw httpError(422, notHere(rt, backend));
  }
  return patch;
}
