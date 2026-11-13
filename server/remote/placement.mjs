// Where an agent runs (#120; designs/architecture/remote-hosts.md, “Remote hosts”): on this computer, or on one of the person’s hosts
// (persona.remote = { hostId }). Which backends run here, which can run on a host, and the checks a persona’s
// placement passes when it’s made or changed. Placement is a service (designs/architecture/services.md, “Placement”):
// it holds no state of its own, and Runtime’s constructor builds it with what it reads.

import { INVISIBLE } from '../../shared/invisible.mjs';
import { lookedText } from '../../shared/remote-protocol.mjs';
import { clipText, httpError } from '../helpers.mjs';

/** A harness’s name for the person, and the host setting that names its path (shared/remote-settings.mjs). */
const HARNESS_LABELS = /** @type {Record<string, [string, string]>} */ ({
  'claude-code': ['Claude Code', 'claudePath'],
  'kiro-cli': ['Kiro CLI', 'kiroPath'],
  codex: ['Codex', 'codexPath'],
});

/**
 * The host’s last welcome says which harnesses its daemon found. Not known yet, the turn’s start says.
 * @param {{ status: (id: string) => any } | null} hosts @param {any} h @param {string} backend
 */
function checkHarness(hosts, h, backend) {
  const w = hosts?.status(h.id)?.welcome;
  if (!Array.isArray(w?.harnesses)) return;
  const found = w.harnesses.find((/** @type {any} */ x) => x?.name === backend);
  if (found?.path) return;
  const [label, setting] = HARNESS_LABELS[backend] ?? [backend, 'its path'];
  const looked = found?.looked?.length ? ` Postbox’s daemon looked in ${lookedText(found)}.` : '';
  throw httpError(
    422,
    `${label} isn’t installed on ${h.name}, so this agent can’t run there.${looked} Install it there, or set ${setting} in the host’s settings.`,
  );
}

/** The host a persona runs on, or null for this computer. @param {any} persona */
export function hostOf(persona) {
  const id = persona?.remote?.hostId;
  return typeof id === 'string' && id ? id : null;
}

/** The backend a persona’s turn runs on. @param {any} persona @returns {string} */
const backendOf = (persona) => persona?.backend ?? 'mock';

// A control character or a lone surrogate (Cs, which the u flag reads one at a time), for clipName.
const NOT_TEXT = /[\p{Cc}\p{Cs}]/gu;

/**
 * A name from the data, for the person (#874): control characters, lone surrogates and every character that hides or
 * reorders text (INVISIBLE, shared/invisible.mjs, #1049) stripped, at most 40 characters.
 * @param {unknown} s
 */
const clipName = (s) => clipText(String(s).replace(NOT_TEXT, '').replace(INVISIBLE, ''), 40);

/**
 * Why an agent whose backend isn’t registered in this Postbox (#874: `POSTBOX_BACKENDS=mock`, `--demo`, the Agent SDK
 * or agy missing, or a name this version doesn’t know) can’t run: for its turn, for a request about it, or for its turn
 * on a host Postbox can’t follow after a restart (#909), which `interrupted()` ends with its own period. A backend
 * Postbox knows goes by its harness’s label; any other by its name, in quotes.
 * @param {string} handle @param {string} backend @param {'turn' | 'request' | 'interrupted'} kind
 */
function unregisteredReason(handle, backend, kind) {
  const name = Object.hasOwn(HARNESS_LABELS, backend) ? HARNESS_LABELS[backend][0] : `“${clipName(backend)}”`;
  const unavailable = `${name} isn’t available on this computer`;
  const fix = 'Install it and restart Postbox, or change this agent’s backend';
  switch (kind) {
    case 'turn':
      return `@${clipName(handle)}’s turn didn’t start: ${unavailable}. ${fix}.`;
    case 'request':
      return `@${clipName(handle)}’s ${unavailable}. ${fix}.`;
    case 'interrupted':
      // The line names the host first, so it says which computer the backend is missing from.
      return `${name} isn’t available to Postbox on this computer, so it can’t follow the turn on the host. Install it here and restart Postbox, or change this agent’s backend`;
  }
  throw new Error(`Unknown kind of unregistered reason: ${kind}`);
}

/**
 * Why a turn on a host can’t be followed after a restart when its agent’s backend isn’t registered here (#909), for
 * `Interrupted on <host>: <why>.`: it has no final period, and no handle, since the line is the agent’s own.
 * @param {any} persona
 */
export const unregisteredWhy = (persona) => unregisteredReason('', backendOf(persona), 'interrupted');

/**
 * Fails a turn whose backend isn’t registered, as refuseHere does (#874): the turn ends with a failed reply and
 * Retry. Its error has no `code`, so a scheduled wake it ran for ends rather than waiting for the network.
 * @param {any} se @param {any} persona
 */
export function refuseUnregistered(se, persona) {
  const text = unregisteredReason(se.handle, backendOf(persona), 'turn');
  throw Object.assign(new Error(text), { userMessage: text });
}

export class Placement {
  /**
   * @param {{ store: { state: any }, midTurn: (sessionId: string) => boolean,
   *           adapters: import('../adapters/adapter.mjs').AdapterRegistry,
   *           hosts: { status: (id: string) => any } | null }} deps
   *   store: the hosts and sessions are read from its state. midTurn: whether a session has a turn running, or a
   *   stopped one still exiting (#126); a host turn waiting to be attached again (#1135) isn’t, so its agent can move
   *   off a host that may never answer. adapters: the registry. hosts: the host manager, for each host’s last welcome.
   */
  constructor({ store, midTurn, adapters, hosts }) {
    this.store = store;
    this.midTurn = midTurn;
    this.adapters = adapters;
    this.hosts = hosts;
  }

  /**
   * The backends that run on this computer: every registered one but those registered to run only on a host (the
   * registry’s here: false). Claude Code, Kiro CLI and Codex are registered that way when their CLI isn’t found
   * (server/index.mjs), since an agent can still run them on a host.
   */
  localBackends() {
    return this.adapters.names().filter((n) => this.adapters.runsHere(n));
  }

  /** @param {string} backend */
  runsHere(backend) {
    return this.adapters.runsHere(backend);
  }

  /** Why a backend can’t run on this computer, and what can. @param {string} backend */
  notHere(backend) {
    const elsewhere = this.registeredAdapter({ backend })?.capabilities?.remote;
    return `“${clipName(backend)}” isn’t available on this computer. Available: ${this.localBackends().join(', ')}.${elsewhere ? ' It can run on one of your hosts: choose one for this agent.' : ''} See README, “Run real agents”.`;
  }

  /**
   * Where a persona runs: null for this computer, or { hostId } for a host Postbox knows. Only a backend that says how
   * it runs remotely (capabilities.remote: Claude Code, Kiro CLI and Codex) can run on a host.
   * @param {unknown} remote @param {string} backend  a registered backend @returns {{ hostId: string } | null}
   */
  placement(remote, backend) {
    if (remote === null || remote === undefined) return null;
    const r = /** @type {Record<string, unknown>} */ (remote);
    if (typeof remote !== 'object' || Array.isArray(remote) || Object.keys(r).some((k) => k !== 'hostId'))
      throw httpError(422, 'Where an agent runs is null, for this computer, or { hostId } for one of your hosts.');
    const hosts = this.store.state.hosts ?? {};
    const h = typeof r.hostId === 'string' && Object.hasOwn(hosts, r.hostId) ? hosts[r.hostId] : null;
    if (!h) throw httpError(422, 'That host doesn’t exist; it may have been removed. Pick one of your hosts, or run the agent on this computer.');
    if (!this.adapters.names().includes(backend))
      throw httpError(422, `“${clipName(backend)}” isn’t available in this Postbox, so it can’t run on ${h.name} either.`);
    if (!this.adapters.get(backend).capabilities?.remote) {
      const can = this.adapters.names().filter((n) => this.adapters.get(n).capabilities?.remote);
      throw httpError(
        422,
        `“${clipName(backend)}” runs only on this computer, so this agent can’t run on ${h.name}. ${can.length ? `Backends here that can run on a host: ${can.join(', ')}.` : 'Claude Code, Kiro CLI and Codex can run on a host, and none of them is on this computer.'}`,
      );
    }
    checkHarness(this.hosts, h, backend);
    return { hostId: h.id };
  }

  /**
   * A persona’s patch with where it runs checked (#120): when that changes, and when its backend does, since only some
   * backends run on a host. On this computer, its backend’s CLI must be here (one that runs only on a host is
   * registered all the same).
   * @param {string} id @param {any} p  the persona as it is @param {any} patch
   */
  placedPatch(id, p, patch) {
    if (patch.remote !== undefined || (patch.backend !== undefined && p.remote)) {
      const remote = this.placement(patch.remote === undefined ? p.remote : patch.remote, patch.backend ?? p.backend);
      if ((remote?.hostId ?? null) !== (p.remote?.hostId ?? null)) {
        const sessions = /** @type {any[]} */ (Object.values(this.store.state.sessions));
        const busy = sessions.some((se) => se.personaId === id && this.midTurn(se.id));
        if (busy) throw httpError(409, `@${p.handle} is in the middle of a turn. Stop it or let it finish, then move it.`);
      }
      patch = { ...patch, remote };
    }
    if ((patch.backend !== undefined || patch.remote !== undefined) && !(patch.remote === undefined ? p.remote : patch.remote)) {
      const backend = patch.backend ?? p.backend;
      if (!this.runsHere(backend)) throw httpError(422, this.notHere(backend));
    }
    return patch;
  }

  /** A persona’s adapter, or null when its backend isn’t registered (#874). @param {any} persona */
  registeredAdapter(persona) {
    return this.adapters.names().includes(backendOf(persona)) ? this.adapters.get(backendOf(persona)) : null;
  }

  /**
   * A persona’s adapter for a request about it, such as its permissions panel or a `!` command’s folder (#874): refused
   * with a 422 and the reason when its backend isn’t registered, where the registry would give a 500.
   * @param {string} handle @param {any} persona
   */
  requestAdapter(handle, persona) {
    const adapter = this.registeredAdapter(persona);
    if (!adapter) throw httpError(422, unregisteredReason(handle, backendOf(persona), 'request'));
    return adapter;
  }

  /**
   * Refuses a turn here whose backend was registered for hosts only (its CLI isn’t here): an agent placed here since
   * its backend’s CLI went. A turn on a host doesn’t call this.
   * @param {any} se @param {any} persona
   */
  refuseHere(se, persona) {
    if (this.runsHere(backendOf(persona))) return;
    const text = `@${se.handle}’s turn didn’t start: ${this.notHere(backendOf(persona))}`;
    throw Object.assign(new Error(text), { userMessage: text });
  }

  /**
   * Refuses a message you send, before anything is posted (#874), when an agent it would wake has a backend that isn’t
   * registered: its turn couldn’t start.
   * @param {any[]} personas
   */
  refuseUnregisteredSend(personas) {
    const p = personas.find((x) => !this.registeredAdapter(x));
    if (p) throw httpError(422, unregisteredReason(p.handle, backendOf(p), 'turn'));
  }

  /**
   * Where `!` commands run for an agent on a host (#67): on this computer even so, in the project’s folder here, else
   * the workspace of its own the agent would have here, never a path on the host; `host` names the host.
   * @param {any} persona @param {any} project @param {any} adapter
   * @returns {Promise<{ folder: string|null, host: string }>}
   */
  async hereFolder(persona, project, adapter) {
    const host = this.store.state.hosts?.[persona.remote.hostId]?.name ?? 'its host';
    // Its own folder is left out: it’s where the agent works, and that’s on the host.
    const here = { ...persona, folder: '' };
    return { folder: (adapter?.folderFor ? await adapter.folderFor(here, project) : project?.folder) || null, host };
  }

  /** The host a persona runs on, or null for this computer. @param {any} persona */
  hostOf(persona) {
    return hostOf(persona);
  }
}
