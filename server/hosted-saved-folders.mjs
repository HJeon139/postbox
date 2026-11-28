// What a hosted Postbox ignores of folders saved before it refused them (designs/architecture/hosted.md, “What
// assumed one computer”): a hosted server has no folder for an agent to work in, so naming one is refused where it
// is named (server/folder-path.mjs, server/permissions-panel.mjs, server/projects.mjs). A folder saved before those
// refusals, or by a Postbox that ran on a computer of someone’s own, would still be read on the server. Each is
// cleared once, as the store loads, as the other start-time changes are (server/permission-modes.mjs).

/**
 * Hosted, clears every folder on the server that a record still names: an agent’s, when it isn’t on a host; a
 * conversation’s added folders; and a project’s. Only a record that has one is written, so a later start writes
 * nothing. An agent on a host keeps its folder, which is a path there. Nothing on your own computer.
 * @param {any} rt
 */
export function dropServerFolders(rt) {
  if (rt.config?.hosted !== true) return;
  for (const p of Object.values(rt.s.personas ?? {})) if (p.folder && !p.remote?.hostId) rt.store.emit('persona', { ...p, folder: '' });
  // As the store loads nothing is held behind a commit, so the state read here is every session as written, as for
  // the other changes made then (server/retired-backends.mjs).
  for (const se of Object.values(rt.s.sessions ?? {})) {
    const patch = se.addDirs?.length ? { addDirs: [] } : {};
    if (Object.keys(patch).length) rt.store.emit('session.patch', { id: se.id, patch });
  }
  for (const { folder, ...project } of Object.values(rt.s.projects ?? {})) if (folder) rt.store.emit('project', project);
}
