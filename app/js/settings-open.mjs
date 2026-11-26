// What the main menu opens on (#1735): which of its lists is on one item’s form as it opens, and where focus goes.
// Kept out of app/js/sheets.mjs, whose openSettings is at its length ceiling.

/**
 * @param {string} tab  the tab it opens on @param {string | null} id  a room’s id, when it opens on that room
 * @param {Record<string, any>} projects  the projects there are
 * @returns {Record<string, any>}  what each list tab is editing (app/js/manage-list.mjs), and its picks as they’re made
 */
export function openAt(tab, id, projects) {
  return {
    // A fresh install has no project, so Projects opens on the form that makes one, not on an empty list.
    projects: tab === 'projects' && !Object.keys(projects).length ? 'new' : null,
    rooms: tab === 'rooms' ? id : null,
    // Opened on a room from the room itself, Save goes back there; from the list, to the list.
    direct: tab === 'rooms' && !!id,
  };
}

/**
 * Where focus starts: on the tab that’s open, whichever way in, so Enter stays on it and a screen reader names it; or
 * in the first field of the form the menu opened on. @param {Record<string, any>} at @param {HTMLElement} tabs
 */
export function focusOpened(at, tabs) {
  /** @type {HTMLElement | null} */ (tabs.querySelector('[aria-selected="true"]'))?.focus();
  if (at.rooms) document.getElementById('rm-title')?.focus();
  if (at.projects === 'new') document.getElementById('pj-n')?.focus();
}
