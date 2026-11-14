// The setup a persona sees in its sheet (#59, #207): the folder it works in, and the MCP servers and plugin skills the
// latest init reported, from its own sessions or another persona’s that loads your setup. setup-routes.mjs answers
// the sheet with it, through Personas.setupFor and the facade’s mcpContext. It reads the state and the personas it’s
// given, and takes no runtime.

import { folderOrNone } from './folder-path.mjs';

/**
 * What the persona sheet’s MCP list needs (#59), given a persona (or none, for a new agent) and a project: the
 * folder it works in (its own, else the project’s, else that of its latest conversation), and the MCP servers the
 * latest init reported. That init comes from one of its sessions, else from any session of a persona that loads
 * your setup, since claude.ai connectors and plugin servers are the same for all of them.
 * @param {any} s  the state @param {(id: string) => any} personaOf @param {string|null} personaId @param {string|null} projectId
 */
export function setupFor(s, personaOf, personaId, projectId) {
  const persona = (personaId && personaOf(personaId)) || null;
  const latest = (list) => list.filter((se) => se.mcpServers?.at).sort((x, y) => y.mcpServers.at - x.mcpServers.at)[0] ?? null;
  const own = persona ? Object.values(s.sessions).filter((se) => se.personaId === persona.id) : [];
  const recent = own.sort((x, y) => (y.startedAt ?? 0) - (x.startedAt ?? 0))[0];
  const project = (projectId && s.projects[projectId]) || s.projects[s.threads[recent?.threadId]?.projectId] || null;
  const seen = latest(own) ?? latest(Object.values(s.sessions).filter((se) => personaOf(se.personaId)?.usesHostSetup !== false && se.backend !== 'mock'));
  const folder = folderOrNone(persona) || project?.folder || null;
  // An init from another folder says nothing about that folder’s project and local servers here: keep only the
  // ones that load everywhere (user, claude.ai, plugins).
  const seenFolder = seen && (folderOrNone(personaOf(seen.personaId)) || s.projects[s.threads[seen.threadId]?.projectId]?.folder || null);
  const servers = seen?.mcpServers.servers ?? [];
  return {
    persona,
    folder,
    seen: seenFolder === folder ? servers : servers.filter((s) => s.source !== 'project' && s.source !== 'local'),
    // Its / menu’s skills (#207), stored as { at, list }: the sheet takes only plugins’, which load in every folder.
    skills: (seen?.commands?.list ?? []).filter((c) => c.skill).map((c) => c.name),
  };
}
