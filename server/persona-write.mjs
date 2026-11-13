// Creating and changing a persona (#57, #59, #60, #120): the checks its setup must pass, where it runs, its folder for
// that place, and the model it gets when it names none. A persona is versioned: each change writes it whole, one
// version on. Moved out of server/runtime.mjs; Runtime keeps a method of the same name that delegates here.

import { AUTO_MODEL, DEFAULT_EFFORT, DEFAULT_MODEL, POSTBOX_SERVER } from './adapters/setup.mjs';
import { placedFolder } from './folder-path.mjs';
import { httpError } from './helpers.mjs';
import { checkedMode } from './permission-modes.mjs';
import { checkEffort, checkSetup, handleOf } from './persona-checks.mjs';
import { newId } from './store.mjs';
import { settleToolAsks } from './tool-ask.mjs';

/** Server names, trimmed and without repeats. Postbox’s own server can’t be turned off, so it’s dropped. */
const serverNames = (list) => [...new Set(list.map((n) => n.trim()))].filter((n) => n !== POSTBOX_SERVER);
const skillNames = (list) => [...new Set(list.map((n) => n.trim()))];
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));

/**
 * The model a persona of this backend gets when it names none: the mock’s, else Claude’s default while the backend
 * offers it, or offers no list yet. A backend that lists models without it gets AUTO_MODEL when it offers that: Codex,
 * which runs none of Claude’s models and always offers AUTO_MODEL, alone when its CLI gave no list (Codex only on a
 * host, #120). Otherwise it gets the first model its harness listed (server/model-lists.mjs), so a Claude Code whose
 * models moved on never gets one it doesn’t run. The Antigravity CLI puts its own default in place of Claude’s.
 * @param {string} backend
 */
function defaultModelFor(rt, backend) {
  if (backend === 'mock') return 'mock';
  const offered = rt.placement.registeredAdapter({ backend })?.capabilities?.models ?? [];
  if (!offered.length || offered.includes(DEFAULT_MODEL)) return DEFAULT_MODEL;
  return offered.includes(AUTO_MODEL) ? AUTO_MODEL : offered[0];
}

export function createPersona(
  rt,
  {
    handle,
    description = '',
    instructions = '',
    backend = 'mock',
    model = defaultModelFor(rt, backend),
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
  },
) {
  handle = handleOf(handle);
  if (rt.personaByHandle(handle)) throw httpError(409, `@${handle} already exists. Pick another name.`);
  if (!rt.adapters.names().includes(backend)) throw httpError(422, rt.placement.notHere(backend));
  permissionMode = checkedMode(permissionMode);
  checkEffort(effort);
  checkSetup({ usesHostSetup, canPublish, mcpOff, skillsOff });
  const placed = rt.placement.placement(remote, backend);
  if (!placed && !rt.placement.runsHere(backend)) throw httpError(422, rt.placement.notHere(backend));
  const p = {
    id: newId('pe'),
    handle,
    description,
    instructions,
    model: String(model || defaultModelFor(rt, backend)),
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
  rt.store.emit('persona', p);
  return p;
}

export function updatePersona(rt, id, patch) {
  // Pending: an agent made behind a held commit can be changed, and a change held there isn’t written over.
  const p = rt.store.pending.persona(id);
  if (!p) throw httpError(404, 'That agent doesn’t exist.');
  if (patch.permissionMode !== undefined) patch = { ...patch, permissionMode: checkedMode(patch.permissionMode) };
  if (patch.effort !== undefined) checkEffort(patch.effort);
  checkSetup(patch);
  if (patch.mcpOff !== undefined) patch = { ...patch, mcpOff: serverNames(patch.mcpOff) };
  if (patch.skillsOff !== undefined) patch = { ...patch, skillsOff: skillNames(patch.skillsOff) };
  if (patch.backend !== undefined && !rt.adapters.names().includes(patch.backend)) throw httpError(422, rt.placement.notHere(patch.backend));
  // Where it runs (#120), and whether its backend runs here when that’s here.
  patch = rt.placement.placedPatch(id, p, patch);
  // Its folder is checked for where it runs once the change is made (#990).
  if (patch.folder !== undefined) patch = { ...patch, folder: placedFolder(patch.folder, patch.remote === undefined ? p.remote : patch.remote) };
  // A persona moved from the mock to a real model gets that backend’s default model.
  if (patch.backend && patch.backend !== 'mock' && (patch.model ?? p.model) === 'mock') patch = { ...patch, model: defaultModelFor(rt, patch.backend) };
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
  rt.store.emit('persona', next);
  // A card that asked for a tool now on answers itself, wherever it was turned on (#237).
  if (patch.tools !== undefined) settleToolAsks(rt, next);
  drainMovedOff(rt, id);
  return next;
}

/**
 * An agent’s place may have changed: what waited in the queue for a host turn to be attached goes now if it moved off
 * that host, since that host may never answer and nothing else would drain it (#1135). An agent still there is busy,
 * and its messages keep waiting. @param {any} rt @param {string} personaId
 */
function drainMovedOff(rt, personaId) {
  for (const se of Object.values(rt.s.sessions))
    if (se.personaId === personaId && rt.remote.restoring.get(se.remoteTurn?.turn) === se.id) rt.drainQueues(se.id, se.threadId);
}
