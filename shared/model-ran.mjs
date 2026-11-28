// How the Model field reads what Postbox kept of each model’s last turn (server/model-runs.mjs, #1977): the order of
// its suggestions, the model it fills in by itself, and the words under the field. Pure, so it is tested without a page.

/** @typedef {{ ended: 'answered' | 'failed', at: number, why?: string }} ModelRun */

/** The models whose last turn there answered, newest first. @param {Record<string, ModelRun> | null | undefined} ran */
const answered = (ran) =>
  Object.entries(ran ?? {})
    .filter(([, run]) => run?.ended === 'answered')
    .sort(([, a], [, b]) => b.at - a.at)
    .map(([model]) => model);

/**
 * The suggestions in the order a person should meet them: the models that answered there, newest first, a model
 * they typed among them; then the harness’s list as it gave it; and last the models whose last turn there failed
 * before its first step. None is left out: a failure can be a minute old and no longer true.
 * @param {string[]} models  the harness’s list @param {Record<string, ModelRun> | null | undefined} ran
 * @returns {string[]}
 */
export function byRan(models, ran) {
  const failed = (/** @type {string} */ m) => ran?.[m]?.ended === 'failed';
  const ran1 = answered(ran);
  const rest = models.filter((m) => !ran1.includes(m));
  return [...ran1, ...rest.filter((m) => !failed(m)), ...rest.filter(failed)];
}

/**
 * The model to fill in for a new agent there, when Postbox picks: the one that answered last, so the first agent a
 * person makes doesn’t fail on a model nobody chose. Nothing when none has answered. @param {Record<string, ModelRun> | null | undefined} ran
 */
export const ranDefault = (ran) => answered(ran)[0] ?? null;

/** The harness’s words as a sentence that ends, so Postbox’s own next one doesn’t run into it. @param {string} why */
const sentence = (why) => (/[.!?…]$/.test(why.trim()) ? why.trim() : `${why.trim()}.`);

/**
 * What the field says of the model in it, or nothing for one no turn has tried. It states what a past turn did, and
 * never that the model works.
 * @param {ModelRun | null | undefined} run @param {{ where: string, when: string }} said  where: “on build-box” or
 *   “here”; when: how long ago, as the page words it
 */
export function ranWords(run, { where, when }) {
  if (run?.ended === 'answered') return `This model’s last turn ${where} answered, ${when}.`;
  if (run?.ended === 'failed')
    return `This model’s last turn ${where} failed before its first step, ${when}${run.why ? `: ${sentence(run.why)}` : '.'} It may run now: Postbox doesn’t know until a turn tries.`;
  return null;
}
