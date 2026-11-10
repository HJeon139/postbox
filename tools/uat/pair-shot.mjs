// The picture a side-by-side judge is shown (#995): the app as the reply left it, finished. A run can end, or the
// person can speak, before the runner has shot an app’s fixed version, so its last shot is the pre-display check at
// work, “fixing a problem”, which no person would judge the picture by. Such a shot is replaced by one taken at the
// end of the run, when the app still shows that version and passed its check; otherwise the run has no pair.

import { join } from 'node:path';
import { appAt } from './intent-match.mjs';
import { replyShot } from './picture-shots.mjs';

/** Check states in which the app itself is on screen (server/apps.mjs, appCheck). */
const SHOWN = new Set(['passed', 'note']);

/**
 * @param {{ data: string, shots: string, label: string, visual: { kind: string, itemId: string }, nextMessageAt: number|null,
 *   shoot?: (label: string, file: string) => Promise<string|null> }} o  shoot: the runner’s shot of an item now, in a live run
 * @returns {Promise<{ shot: { file: string, at: number }, retaken?: boolean } | { skipped: string }>}
 */
export async function pairShot({ data, shots, label, visual, nextMessageAt, shoot }) {
  const shot = replyShot(shots, label, nextMessageAt);
  if (!shot) return { skipped: `no screenshot of the agent’s ${visual.kind}` };
  const app = visual.kind === 'app' ? appAt(data, visual.itemId) : null;
  const versions = app?.versions ?? [];
  const last = versions.findLast((v) => nextMessageAt === null || v.at < nextMessageAt);
  if (!last || shot.at >= last.at) return { shot };
  // The shot is older than the reply’s last version. Retake it only while the app still shows that one, finished.
  if (shoot && last === versions.at(-1) && SHOWN.has(app?.check ?? '')) {
    const file = await shoot(label, join(shots, `judge-${label}.png`));
    if (file) return { shot: { file, at: Date.now() }, retaken: true };
  }
  return { skipped: `no screenshot of the ${visual.kind}’s finished version (v${last.v})` };
}
