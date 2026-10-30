// Playwright’s global setup: the run takes one of this machine’s heavy-suite slots before any worker starts, and lets
// it go when the run ends (tools/heavy-lock.mjs). On CI the runner is the run’s alone, so it takes none.

import { acquire } from '../../tools/heavy-lock.mjs';

export default async function heavySlot() {
  if (process.env.CI || process.env.POSTBOX_HEAVY_HELD) return;
  const label = `playwright${process.env.POSTBOX_STREAM_LAG ? ', lag' : ''} in ${process.cwd()}`;
  return acquire({ label });
}
