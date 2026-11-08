// Which of the runner’s screenshots shows a picture as the person saw it (#995). The runner shoots each block, app
// and diagram whenever it changes, before the tester’s next step, as shots/<steps so far>-<label>.png
// (tools/uat/observe.mjs). An app’s first shot is often its pre-display check at work, so a judge needs a later one.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The shots of the item labeled `label`, in the order they were taken.
 * @param {string} shots  the run’s shots folder @param {string} label  such as I3
 * @returns {{ n: number, file: string, at: number }[]}  n: the steps the run had taken when it took the shot
 */
export function shotsOf(shots, label) {
  if (!label || !existsSync(shots)) return [];
  return readdirSync(shots)
    .map((f) => ({ f, m: /^(\d+)-(I\d+)\.png$/.exec(f) }))
    .filter(({ m }) => m && m[2] === label)
    .map(({ f, m }) => ({ n: Number(m?.[1]), file: join(shots, f), at: statSync(join(shots, f)).mtimeMs }))
    .sort((a, b) => a.n - b.n);
}

/** The shot the tester looked at on `step`: the last one taken before it. @param {string} shots @param {string} label @param {number} step */
export function shotAtStep(shots, label, step) {
  return shotsOf(shots, label).findLast((s) => s.n < step) ?? null;
}

/**
 * The picture as the reply it’s in left it: the last shot taken before the person’s next message, or the last shot when
 * nothing came after. By time, from Postbox’s log (tools/uat/picture-choice.mjs, firstExchange), since the tester’s
 * answer to a card isn’t a message.
 * @param {string} shots @param {string} label @param {number|null} nextMessageAt
 */
export function replyShot(shots, label, nextMessageAt) {
  const all = shotsOf(shots, label);
  return all.findLast((s) => nextMessageAt === null || s.at < nextMessageAt) ?? all.at(-1) ?? null;
}
