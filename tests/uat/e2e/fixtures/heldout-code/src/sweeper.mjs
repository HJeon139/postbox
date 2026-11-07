import { SWEEP_MS } from './config.mjs';
import { releaseExpired } from './jobs.mjs';
import { log } from './log.mjs';

export function startSweeper() {
  return setInterval(() => {
    for (const id of releaseExpired(Date.now())) log(`sweeper requeue job=${id} lease expired`);
  }, SWEEP_MS);
}
