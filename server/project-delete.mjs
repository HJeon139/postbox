// Deleting a project (#119). Its conversations go with it, each as deleting it would: its agents’ sessions, its topic
// and side threads, its apps and its room’s assets (the person’s choice, 23 November 2026). The personas stay, and so
// does its folder on this computer, with every file in it.

import { httpError } from './helpers.mjs';

/**
 * Deletes a project and every conversation in it. The last project is refused, since Postbox opens on one. Read
 * pending, as a delete’s every lookup is: a conversation started behind a held commit goes too.
 * @param {any} rt @param {string} projectId @returns {{ name: string, conversations: number }}
 */
export function deleteProject(rt, projectId) {
  const p = rt.store.pending.project(projectId);
  if (!p) throw httpError(404, 'That project doesn’t exist. It may have been deleted.');
  if (Object.keys(rt.store.state.projects).length < 2)
    throw httpError(409, 'This is the only project, and Postbox opens on one. Add another project, then delete this one.');
  // Each conversation’s own delete takes its topic and side threads with it.
  const conversations = Object.values(rt.store.pending.threads()).filter((t) => t.projectId === projectId && !t.parentId);
  for (const t of conversations) rt.deleteThread(t.id);
  rt.store.emit('remove', { kind: 'project', id: projectId });
  return { name: p.name, conversations: conversations.length };
}
