import { scheduleReminders } from './bookings.mjs';
import { WORKERS } from './config.mjs';
import { log } from './log.mjs';
import { startSweeper } from './sweeper.mjs';
import { runWorker } from './worker.mjs';

log(`start workers=${WORKERS} scheduled=${scheduleReminders()}`);
setInterval(() => scheduleReminders(), 3_600_000);
startSweeper();
for (let w = 1; w <= WORKERS; w += 1) {
  runWorker(w).catch((err) => {
    log(`worker=${w} stopped: ${err.message}`);
    process.exit(1);
  });
}
