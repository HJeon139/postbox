import { POLL_MS } from './config.mjs';
import { sendReminder } from './handlers/send-reminder.mjs';
import { claim, complete, fail } from './jobs.mjs';
import { log } from './log.mjs';

const HANDLERS = { 'send-reminder': sendReminder };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runWorker(worker) {
  for (;;) {
    const job = claim(worker, Date.now());
    if (!job) {
      await sleep(POLL_MS);
      continue;
    }
    log(`worker=${worker} claim job=${job.id} attempt=${job.attempts}`);
    try {
      await HANDLERS[job.type](job, worker, Date.now());
      complete(job.id);
      log(`worker=${worker} complete job=${job.id}`);
    } catch (err) {
      const after = fail(job.id, err.message, Date.now());
      log(`worker=${worker} fail job=${job.id} attempt=${job.attempts} ${after?.state === 'dead' ? 'dead' : 'retry'}: ${err.message}`);
    }
  }
}
