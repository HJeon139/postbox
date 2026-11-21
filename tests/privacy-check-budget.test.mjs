// The privacy checker’s time on long input with no address in it: a regex that backtracks on repeated text would
// spend seconds there. Moved from fixtures-privacy.test.mjs, which is at its size ceiling.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkContentPrivacy } from '../tools/privacy-check.mjs';

test('privacy checker reads 200 KB with no address in well under a second, whatever it repeats', () => {
  // The budget is the checker’s own work, as CPU time: a wall clock also counts the time a loaded machine gives other
  // processes, and failed this at 127 ms on a few ms of work (#1251). A regex that backtracks spends seconds.
  for (const unit of ['a', '.', '-', '/', '\\', '1', '_', 'a.', 'a-', '-a']) {
    const text = unit.repeat(200_000 / unit.length);
    const started = process.cpuUsage();
    checkContentPrivacy(text);
    const { user, system } = process.cpuUsage(started);
    const elapsed = (user + system) / 1000;
    assert.ok(elapsed < 100, `${JSON.stringify(unit)} took ${Math.round(elapsed)} ms of CPU time`);
  }
});
