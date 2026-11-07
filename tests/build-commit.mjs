// Whether a build line's commit is HEAD's, for tests/process/install.test.mjs (#919).
// The installed package always shows 7 characters (server/build-info.mjs), while `git rev-parse --short=7`
// gives more when 7 are ambiguous, so the check takes the shown commit as a prefix of HEAD's full sha.

const SHOWN = /^[0-9a-f]{7}$/;

/**
 * @param {unknown} shown  the commit the build line shows
 * @param {string|null} full  HEAD's full sha
 */
export function buildCommitMatches(shown, full) {
  return typeof shown === 'string' && typeof full === 'string' && SHOWN.test(shown) && full.startsWith(shown);
}
