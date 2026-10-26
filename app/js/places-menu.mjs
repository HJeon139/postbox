// Project rows in the top-bar places menu (#432).

export function projectPlaces(projects, currentId, needsIn, open) {
  return projects.map((project) => ({
    label: project.name,
    desc: needsIn(project.id) ? `${needsIn(project.id)} need you` : (project.folder ?? '').replace(/^\/Users\/[^/]+/, '~'),
    icon: 'folder',
    current: project.id === currentId,
    kbd: project.id === currentId ? '✓' : null,
    run: () => open(project.id),
  }));
}
