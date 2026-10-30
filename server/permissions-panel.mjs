// The permissions panel (#66), moved from server/runtime.mjs, whose Runtime keeps a one-line method for each of
// these functions; each takes the runtime first (rt). The panel has no state of its own: it reads the persona, the
// session and the project from the runtime, and rules from the settings files (server/permission-rules.mjs); it
// writes a rule to those files, a conversation’s rules and folders to its session, and a persona’s mode to it.
//
// For one agent in one conversation (or, from the persona editor, an agent on its own): its mode, its rules with
// where each comes from, the folders it may work in, and what Postbox may change. Rules live where Claude Code
// reads them, so a rule made here shows in the CLI’s /permissions, and the reverse; rules for this conversation
// only live on the session and are passed with every turn.

import { stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { PUBLISHING_TOOLS, setupOf, TOOL_RULES, writeRules } from './adapters/setup.mjs';
import { httpError } from './helpers.mjs';
import { BEHAVIORS, changeRule, cleanRule, readRules, settingsFiles } from './permission-rules.mjs';

/**
 * What a persona may do without asking. auto (the default): Claude Code’s safety classifier approves routine
 * actions and asks you only when it can’t decide. ask: ask before anything risky. acceptEdits: edit files
 * freely, ask before commands. bypass: never ask.
 */
export const PERMISSION_MODES = ['auto', 'ask', 'acceptEdits', 'bypass'];
// What a conversation keeps for the permissions panel (#66), bounded.
const MAX_CONVERSATION_RULES = 200;
const MAX_ADD_DIRS = 20;

/**
 * Who the panel is about: { se, persona, project, folder }. A session’s persona is the one it runs with now.
 * @param {any} rt @param {{ sessionId?: string|null, personaId?: string|null, projectId?: string|null }} who
 */
export async function panelTarget(rt, { sessionId = null, personaId = null, projectId = null }) {
  const se = sessionId ? rt.session(sessionId) : null;
  const persona = se ? rt.personaFor(se) : personaId ? rt.persona(personaId) : null;
  if (!persona) throw httpError(404, 'That agent doesn’t exist.');
  const project = rt.s.projects[se ? rt.s.threads[se.threadId]?.projectId : (projectId ?? '')] ?? rt.latestProject(persona.id) ?? null;
  const adapter = rt.adapters.get(persona.backend);
  const folder = adapter?.folderFor ? await adapter.folderFor(persona, project) : persona.folder || project?.folder || null;
  return { se, persona, project, folder };
}
/** The project of a persona’s latest conversation, for the panel opened from the persona editor. */
export function latestProject(rt, personaId) {
  const recent = Object.values(rt.s.sessions)
    .filter((x) => x.personaId === personaId)
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0];
  return recent ? rt.s.projects[rt.s.threads[recent.threadId]?.projectId] : null;
}

/**
 * Everything the panel shows. Rule lists carry their source: user, project, local (the settings files), conversation
 * (rt session’s), tools (the persona’s unticked Tools, as deny rules), publishing (when it may not publish outside
 * Postbox), writes (ask rules for writes outside Postbox, #112) and postbox (its own tools, always allowed).
 * @param {any} rt @param {{ sessionId?: string|null, personaId?: string|null, projectId?: string|null }} who
 */
export async function permissionsView(rt, who) {
  const { se, persona, project, folder } = await rt.panelTarget(who);
  const real = persona.backend !== 'mock';
  // The mock shows its rules too (the Tools ones); a real backend that doesn’t read Claude Code’s shows none.
  const readsRules = !real || rt.readsRules(persona.backend);
  const { usesHostSetup, canPublish, allowRequested } = setupOf(persona);
  const files = real && readsRules && folder ? await readRules({ folder, home: rt.home, configDir: rt.configDir, usesHostSetup }) : [];
  const has = new Set(persona.tools ?? []);
  const tools = Object.entries(TOOL_RULES).map(([id, rules]) => ({ id, on: has.has(id), rules }));
  const conversation = se ? { allow: [...(se.rules?.allow ?? [])], ask: [...(se.rules?.ask ?? [])], deny: [...(se.rules?.deny ?? [])] } : null;
  const running = Object.values(rt.s.sessions).filter((x) => x.personaId === persona.id && rt.turns.has(x.id));
  return {
    persona: {
      id: persona.id,
      handle: persona.handle,
      backend: persona.backend,
      permissionMode: persona.permissionMode ?? 'auto',
      usesHostSetup,
      canPublish,
      allowRequested,
      // On a host (#120), its Claude Code reads the settings files there, not the ones this panel reads here.
      host: persona.remote?.hostId ? (rt.s.hosts?.[persona.remote.hostId]?.name ?? 'a host') : null,
    },
    sessionId: se?.id ?? null,
    projectId: project?.id ?? null,
    real,
    readsRules,
    folder,
    projectFolder: project?.folder ?? null,
    home: rt.home,
    files,
    conversation,
    tools,
    publishing: canPublish ? [] : [...PUBLISHING_TOOLS],
    // Writes outside Postbox ask first (#112), except what the persona may publish, for a backend that reads rules.
    writes: { rules: real && readsRules ? writeRules(persona) : [], unless: canPublish ? [...PUBLISHING_TOOLS] : [] },
    folders: [
      ...(folder ? [{ path: folder, source: 'folder' }] : []),
      ...(project?.folder && project.folder !== folder ? [{ path: project.folder, source: 'project' }] : []),
      ...(se?.addDirs ?? []).map((path) => ({ path, source: 'conversation' })),
      ...files.flatMap((f) => f.dirs.map((path) => ({ path, source: f.source }))),
    ],
    // Agents of rt persona with a turn running now: a mode change reaches them now only where the backend allows.
    running: running.map((x) => x.handle),
  };
}

/**
 * Adds or removes a rule. where: local (the default, as the CLI saves “don’t ask again”), user (the person’s own
 * settings, only for a persona that loads them) or conversation (rt session only). The project’s shared
 * settings.json is never written.
 * @param {any} rt @param {{ sessionId?: string|null, personaId?: string|null, projectId?: string|null, behavior: string, rule: string,
 *           where?: string, remove?: boolean }} change
 */
export async function changePermissionRule(rt, { sessionId = null, personaId = null, projectId = null, behavior, rule, where = 'local', remove = false }) {
  if (!BEHAVIORS.includes(/** @type {any} */ (behavior))) throw httpError(422, 'A rule allows, asks or denies.');
  const clean = cleanRule(rule);
  if (!clean)
    throw httpError(
      422,
      'That isn’t a rule. Write a tool name, and what it covers in parentheses: Bash(npm test:*), WebFetch(domain:example.com), Read(./src/**).',
    );
  if (where === 'project')
    throw httpError(
      409,
      'The project’s settings are shared with your team, so Postbox doesn’t change them. Save the rule in rt folder’s local settings, or edit .claude/settings.json yourself.',
    );
  if (!['local', 'user', 'conversation'].includes(where))
    throw httpError(422, 'A rule is saved in rt folder’s local settings, your user settings or rt conversation.');
  const { se, persona, folder } = await rt.panelTarget({ sessionId, personaId, projectId });
  if (persona.backend === 'mock' || !rt.readsRules(persona.backend)) throw httpError(409, 'Only Claude Code and Agent SDK agents read permission rules.');
  const b = /** @type {'allow'|'ask'|'deny'} */ (behavior);
  if (where === 'conversation') {
    if (!se) throw httpError(409, 'Open the panel from a conversation to make a rule for it only.');
    const rules = { allow: [...(se.rules?.allow ?? [])], ask: [...(se.rules?.ask ?? [])], deny: [...(se.rules?.deny ?? [])] };
    if (remove) rules[b] = rules[b].filter((r) => r !== clean);
    else if (!rules[b].includes(clean)) {
      if (rules[b].length >= MAX_CONVERSATION_RULES) throw httpError(422, `A conversation keeps up to ${MAX_CONVERSATION_RULES} ${b} rules.`);
      rules[b].push(clean);
    }
    rt.updateSession(se.id, { rules });
    return { ok: true, where, applies: 'next turn' };
  }
  if (where === 'user' && !setupOf(persona).usesHostSetup)
    throw httpError(
      409,
      `@${persona.handle} is isolated, so it doesn’t read your user settings. Save the rule in rt folder’s local settings, or rt conversation.`,
    );
  if (!folder) throw httpError(409, `@${persona.handle} has no folder yet, so there’s no local settings file to save in.`);
  const files = settingsFiles(folder, rt.home, rt.configDir);
  const { file, changed } = await changeRule(files[/** @type {'local'|'user'} */ (where)], { behavior: b, rule: clean, remove });
  return { ok: true, where, file, changed, applies: 'next turn' };
}

/**
 * Adds a folder rt conversation’s agent may work in, passed as --add-dir / additionalDirectories from its next
 * turn, or removes one. path is absolute, or relative to the project’s folder (from the folder picker).
 * @param {any} rt @param {{ sessionId: string, path: string, remove?: boolean }} change
 */
export async function changePermissionFolder(rt, { sessionId, path, remove = false }) {
  const se = rt.session(sessionId);
  const project = rt.s.projects[rt.s.threads[se.threadId]?.projectId];
  const raw = String(path ?? '').trim();
  if (!raw || raw.length > 1000) throw httpError(422, 'Pick a folder, or write its full path.');
  const dir = isAbsolute(raw) ? resolve(raw) : project?.folder ? resolve(project.folder, raw) : null;
  if (!dir) throw httpError(422, 'Write the folder’s full path.');
  const dirs = [...(se.addDirs ?? [])];
  if (remove) {
    rt.updateSession(se.id, { addDirs: dirs.filter((d) => d !== dir) });
    return { ok: true, path: dir };
  }
  const st = await stat(dir).catch(() => null);
  if (!st?.isDirectory()) throw httpError(422, `${dir} isn’t a folder on rt computer.`);
  if (!dirs.includes(dir)) {
    if (dirs.length >= MAX_ADD_DIRS) throw httpError(422, `A conversation can add up to ${MAX_ADD_DIRS} folders.`);
    rt.updateSession(se.id, { addDirs: [...dirs, dir] });
  }
  return { ok: true, path: dir, applies: 'next turn' };
}

/**
 * Sets a persona’s permission mode (intent.md: it reaches running conversations from their next turn). Where the
 * backend can change a running turn (the Agent SDK’s setPermissionMode), its running turns change now too.
 * @param {any} rt @param {string} personaId @param {string} mode
 * @returns {Promise<{ ok: true, now: string[], later: string[] }>}  now: the sessions whose running turn changed at once;
 *   later: those with a turn running that keeps the mode it started with until it ends (#371), which Stop applies now.
 *   Sessions, not handles: a persona has one in each conversation it’s in.
 */
export async function setPermissionMode(rt, personaId, mode) {
  const p = rt.persona(personaId);
  if (!p) throw httpError(404, 'That agent doesn’t exist.');
  if (!PERMISSION_MODES.includes(mode)) throw httpError(422, `Permissions are one of ${PERMISSION_MODES.join(', ')}.`);
  if ((p.permissionMode ?? 'auto') !== mode) rt.updatePersona(personaId, { permissionMode: mode });
  const now = [];
  const later = [];
  for (const se of Object.values(rt.s.sessions)) {
    const turn = se.personaId === personaId ? rt.turns.get(se.id) : null;
    if (turn?.control?.setPermissionMode && (await turn.control.setPermissionMode(mode))) now.push(se.id);
    else if (turn) later.push(se.id);
  }
  return { ok: true, now, later };
}
