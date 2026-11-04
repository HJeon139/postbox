// The base a change is compared with, for the lints that check only what a change adds (tools/lint-caps.mjs,
// tools/lint-ternary.mjs): the merge base of HEAD with origin/main, or with origin/$BASE_REF when that is set, or with
// the ref given on the command line. With no base to find, a lint fails in CI and skips elsewhere (noBase).

/** The ref to compare with: the one given, else origin/$BASE_REF, else origin/main. */
export function baseRef(/** @type {string | undefined} */ given, /** @type {Record<string, string | undefined>} */ env) {
  return given ?? `origin/${env.BASE_REF || 'main'}`;
}

/**
 * The merge base of ref and HEAD, or '' when there is none (no such ref, or no history in common).
 * @param {(args: string[]) => string} git @param {string} ref
 */
export function mergeBase(git, ref) {
  try {
    return git(['merge-base', ref, 'HEAD']).trim();
  } catch {
    return '';
  }
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
