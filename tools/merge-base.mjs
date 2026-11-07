// The base a change is compared with, for the lints that check only what a change adds (tools/lint-caps.mjs,
// tools/lint-ternary.mjs): the merge base of HEAD with origin/main and upstream/main, whichever exist, so a fork whose
// origin/main is behind upstream/main isn’t blamed for upstream’s own code (#786); or with origin/$BASE_REF alone when
// that is set (CI); or with the ref given on the command line. Nothing is fetched: the refs are as the person last
// fetched them, so a failure names them. With no base to find, a lint fails in CI and skips elsewhere (noBase).

/** The refs to compare with: the one given, else origin/$BASE_REF, else origin/main and upstream/main. */
export function baseRefs(/** @type {string | undefined} */ given, /** @type {Record<string, string | undefined>} */ env) {
  if (given) return [given];
  if (env.BASE_REF) return [`origin/${env.BASE_REF}`];
  return ['origin/main', 'upstream/main'];
}

/**
 * The merge base of HEAD with the refs that exist, in one git merge-base so it is the newest base of them all, and
 * those refs; at is '' when there is none (no such ref, or no history in common).
 * @param {(args: string[]) => string} git @param {string[]} candidates
 */
export function mergeBase(git, candidates) {
  const refs = candidates.filter((ref) => {
    try {
      git(['rev-parse', '--verify', '-q', `${ref}^{commit}`]);
      return true;
    } catch {
      return false;
    }
  });
  if (!refs.length) return { at: '', refs };
  try {
    return { at: git(['merge-base', 'HEAD', ...refs]).trim(), refs };
  } catch {
    return { at: '', refs };
  }
}

/**
 * The line a failure ends with, naming the base and the refs it came from, and outside CI how to bring them up to date.
 * @param {string} at @param {string[]} refs @param {Record<string, string | undefined>} env
 */
export function comparedWith(at, refs, env) {
  const line = `Compared with ${at.slice(0, 8)}, the merge base of HEAD with ${refs.join(' and ')}.`;
  return env.CI ? line : `${line} If that is behind, run git fetch and try again.`;
}

/**
 * What a run with no base to compare with does: in CI it fails, since that is a broken checkout and must not pass as a
 * clean guard; elsewhere it skips.
 * @param {string} tool @param {string} ref @param {Record<string, string | undefined>} env
 */
export function noBase(tool, ref, env) {
  if (env.CI) return { code: 1, message: `${tool}: failed, there is no ${ref} to compare with.` };
  return { code: 0, message: `${tool}: skipped, there is no ${ref} to compare with.` };
}
