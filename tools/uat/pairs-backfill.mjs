// The first picture of a run that finished before #995 recorded it, read from the run’s folder and saved into its
// run.json as a live run would have, at no cost. The runner’s item labels aren’t kept, so the picture’s label is the
// one the customer judged first, which `- judge: visual` asks of the first visual.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { firstExchange } from './picture-choice.mjs';
import { writeJsonAtomic } from './runs.mjs';
import { firstPicture } from './side-by-side.mjs';

/** The item the customer judged first, from the report’s visual verdicts, or null. @param {string} report */
export function firstJudged(report) {
  const at = report.indexOf('## Visual verdicts');
  if (at < 0) return null;
  return /^\| \d+ \| (I\d+) \|/m.exec(report.slice(at))?.[1] ?? null;
}

/**
 * A finished run’s first picture: its run.json’s, or read from its folder and saved there.
 * @param {string} dir  the run’s folder
 */
export async function pictureOfRun(dir) {
  const saved = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
  if (saved.firstPicture) return saved.firstPicture;
  const report = existsSync(join(dir, 'report.md')) ? readFileSync(join(dir, 'report.md'), 'utf8') : '';
  const label = firstJudged(report);
  const visual = firstExchange(join(dir, 'data'))?.visual;
  if (!label || !visual) return { skipped: 'no judged first picture' };
  const picture = await firstPicture({ dir, data: join(dir, 'data'), shots: join(dir, 'shots'), labels: new Map([[visual.itemId, label]]) });
  writeJsonAtomic(join(dir, 'run.json'), { ...saved, firstPicture: picture });
  return picture;
}
