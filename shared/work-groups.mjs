// The Work pane’s Files, by where each file stands (#1446): a file to review goes to the top of Files, so the group
// that holds one comes first, and within each group flagged files come first, then the newest.

/** Where a file stands, in the order the pane lists them when none is flagged. */
export const FILE_STATES = /** @type {const} */ (['uncommitted', 'committed', 'pushed', 'outside']);

/**
 * The pane’s groups of files, each { state, files }, in order. @param {any[]} files
 * @param {(f: any) => string} stateOf @param {(f: any) => boolean} isFlagged
 */
export function fileGroups(files, stateOf, isFlagged) {
  const groups = FILE_STATES.map((state) => ({
    state,
    files: files.filter((f) => stateOf(f) === state).sort((a, b) => Number(isFlagged(b)) - Number(isFlagged(a)) || (b.lastAt ?? 0) - (a.lastAt ?? 0)),
  })).filter((g) => g.files.length);
  const flaggedIn = (g) => g.files.some(isFlagged);
  return [...groups.filter(flaggedIn), ...groups.filter((g) => !flaggedIn(g))];
}
