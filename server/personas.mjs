// Personas (designs/architecture/services.md, “Personas”): creating, changing, finding and removing them, the checks a
// persona’s setup must pass (#57, #59, #60), where it runs (#120), its folder for that place, and the model it gets
// when it names none. A persona is versioned: each change writes it whole, one version on. Personas is a service:
// Runtime’s constructor builds it with the store, the bus, Placement and the adapter registry. Its invariants: a
// handle is unique among personas not retired, ignoring case; a persona’s backend is registered and can run where it’s
// placed; a stored retired permission mode runs as Auto. After a change it signals persona.updated, and the root’s
// listeners do what that means for host turns, sessions, tool asks and the queue.

import { modelDefault } from '../shared/agent-facts.mjs';
import { DEFAULT_EFFORT, DEFAULT_MODEL, POSTBOX_SERVER } from './adapters/setup.mjs';
import { placedFolder } from './folder-path.mjs';
import { httpError } from './helpers.mjs';
import { checkedMode, runsAs } from './permission-modes.mjs';
import { checkEffort, checkModel, checkSetup, handleOf } from './persona-checks.mjs';
import { setupFor } from './setup-context.mjs';
import { newId } from './store.mjs';

/** Server names, trimmed and without repeats. Postbox’s own server can’t be turned off, so it’s dropped. */
const serverNames = (list) => [...new Set(list.map((n) => n.trim()))].filter((n) => n !== POSTBOX_SERVER);
const skillNames = (list) => [...new Set(list.map((n) => n.trim()))];
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));

/**
 * The model a persona of this backend gets when it names none: the mock’s, else the one the New agent sheet would
 * start it on, from what its backend offers (shared/agent-facts.mjs, modelDefault, #390).
 * @param {import('./remote/placement.mjs').Placement} placement @param {string} backend
 */
function defaultModelFor(placement, backend) {
  if (backend === 'mock') return 'mock';
  const capabilities = placement.registeredAdapter({ backend })?.capabilities ?? {};
  return modelDefault(backend, { defaultModel: DEFAULT_MODEL, backends: { [backend]: capabilities } });
}

export class Personas {
  /**
   * @param {{ store: import('./store.mjs').Store, bus: import('./bus.mjs').Bus, placement: import('./remote/placement.mjs').Placement,
   *           adapters: import('./adapters/adapter.mjs').AdapterRegistry }} deps
   */
  constructor({ store, bus, placement, adapters }) {
    this.store = store;
    this.bus = bus;
    this.placement = placement;
    this.adapters = adapters;
  }

  // ── Finding ────────────────────────────────────────────────────────────────────────

  /** A persona, or undefined. @param {string} id */
  get(id) {
    return this.store.state.personas[id];
  }

  /**
   * The persona a session runs with: the persona as it is now. One rule for every setting: a turn takes the persona
   * when it starts (adapterContext, server/turn-context.mjs), so every change applies from the agent’s next turn, in
   * every conversation it’s in, and never to a turn already running. @param {{ personaId: string }} se
   */
  forSession(se) {
    const p = this.get(se.personaId);
    return (
      p && {
        ...p,
        permissionMode: runsAs(p.permissionMode),
        // Whether it loads your Claude Code setup and may publish outside Postbox are permissions too (#57), and
        // so are the MCP servers it turned off (#59) and its tools, which real backends deny when unticked (#5).
        usesHostSetup: p.usesHostSetup !== false,
        canPublish: p.canPublish === true,
        mcpOff: p.mcpOff ?? [],
        skillsOff: p.skillsOff ?? [],
        tools: p.tools ?? [],
      }
    );
  }

  /** The persona with that handle, ignoring case, among those not retired. @param {unknown} handle */
  byHandle(handle) {
    return Object.values(this.store.state.personas).find((p) => p.handle.toLowerCase() === String(handle).toLowerCase() && !p.retired);
  }

  /** The handles of the personas not retired. */
  handles() {
    return Object.values(this.store.state.personas)
      .filter((p) => !p.retired)
      .map((p) => p.handle);
  }

  // ── Writing ────────────────────────────────────────────────────────────────────────

  /** A new persona, at version 1. @param {any} spec */
  create({
    handle,
    description = '',
    instructions = '',
    backend = 'mock',
    model = defaultModelFor(this.placement, backend),
    effort = DEFAULT_EFFORT,
    permissionMode = 'auto',
    usesHostSetup = true,
    canPublish = false,
    mcpOff = [],
    skillsOff = [],
    folder = '',
    tools = [],
    examples = [],
    createdBy = null,
    remote = null,
  }) {
    handle = handleOf(handle);
    if (this.byHandle(handle)) throw httpError(409, `@${handle} already exists. Pick another name.`);
    if (!this.adapters.names().includes(backend)) throw httpError(422, this.placement.notHere(backend));
    permissionMode = checkedMode(permissionMode);
    checkEffort(effort);
    checkModel(model);
    checkSetup({ usesHostSetup, canPublish, mcpOff, skillsOff });
    const placed = this.placement.placement(remote, backend);
    if (!placed && !this.placement.runsHere(backend)) throw httpError(422, this.placement.notHere(backend));
    const p = {
      id: newId('pe'),
      handle,
      description,
      instructions,
      model: String(model || defaultModelFor(this.placement, backend)),
      effort,
      backend,
      permissionMode,
      usesHostSetup,
      canPublish,
      mcpOff: serverNames(mcpOff),
      skillsOff: skillNames(skillsOff),
      folder: placedFolder(folder, placed),
      tools: [...new Set(tools)],
      examples,
      createdBy,
      remote: placed,
      createdAt: Date.now(),
      version: 1,
      retired: false,
    };
    this.store.emit('persona', p);
    return p;
  }

  /**
   * Changes a persona, one version on, and signals persona.updated with it as written, as it was, and the change asked
   * for. @param {string} id @param {Record<string, any>} patch
   */
  update(id, patch) {
    // Pending: an agent made behind a held commit can be changed, and a change held there isn’t written over.
    const p = this.store.pending.persona(id);
    if (!p) throw httpError(404, 'That agent doesn’t exist.');
    if (patch.permissionMode !== undefined) patch = { ...patch, permissionMode: checkedMode(patch.permissionMode) };
    if (patch.effort !== undefined) checkEffort(patch.effort);
    if (patch.model !== undefined) checkModel(patch.model);
    checkSetup(patch);
    if (patch.mcpOff !== undefined) patch = { ...patch, mcpOff: serverNames(patch.mcpOff) };
    if (patch.skillsOff !== undefined) patch = { ...patch, skillsOff: skillNames(patch.skillsOff) };
    if (patch.backend !== undefined && !this.adapters.names().includes(patch.backend)) throw httpError(422, this.placement.notHere(patch.backend));
    // Where it runs (#120), and whether its backend runs here when that’s here.
    patch = this.placement.placedPatch(id, p, patch);
    // Its folder is checked for where it runs once the change is made (#990).
    if (patch.folder !== undefined) patch = { ...patch, folder: placedFolder(patch.folder, patch.remote === undefined ? p.remote : patch.remote) };
    // A persona moved from the mock to a real model gets that backend’s default model.
    if (patch.backend && patch.backend !== 'mock' && (patch.model ?? p.model) === 'mock')
      patch = { ...patch, model: defaultModelFor(this.placement, patch.backend) };
    const next = {
      ...p,
      ...pick(patch, [
        'description',
        'instructions',
        'backend',
        'model',
        'effort',
        'permissionMode',
        'usesHostSetup',
        'canPublish',
        'allowRequested',
        'mcpOff',
        'skillsOff',
        'folder',
        'tools',
        'examples',
        'retired',
        'remote',
      ]),
      version: (p.version ?? 1) + 1,
    };
    this.store.emit('persona', next);
    this.bus.emit('persona.updated', { persona: next, was: p, patch });
    return next;
  }

  /**
   * Removes a persona at once, with no Undo window, and each backend forgets what it remembered (an adapter’s forget,
   * such as the Claude adapters’ memory folders, #208). A new persona with the same name starts clean, since memory is
   * kept by id. Its sessions go first, in the facade’s deletePersona.
   * @param {string} id @returns {{ handle: string, forgotten: Promise<void> }}  forgotten settles once every backend has forgotten it
   */
  remove(id) {
    // Pending: an agent made behind a held commit can be removed.
    const p = this.store.pending.persona(id);
    if (!p) throw httpError(404, 'That agent doesn’t exist.');
    this.store.emit('remove', { kind: 'persona', id });
    return { handle: p.handle, forgotten: this.forget(p) };
  }

  /**
   * Each backend forgets the persona. A memory that can’t be removed stays on disk, and the server log says where; the
   * persona is gone either way. @param {any} p
   */
  async forget(p) {
    for (const name of this.adapters.names()) {
      const adapter = this.adapters.get(name);
      if (typeof adapter.forget !== 'function') continue;
      await adapter.forget(p).catch((/** @type {any} */ e) => console.error(`Postbox couldn’t remove @${p.handle}’s memory (${name}): ${e.message}`));
    }
  }

  // ── What the persona sheet shows: server/setup-context.mjs ─────────────────────────

  /** @param {string|null} personaId @param {string|null} projectId */
  setupFor(personaId, projectId) {
    return setupFor(this.store.state, (id) => this.get(id), personaId, projectId);
  }
}
