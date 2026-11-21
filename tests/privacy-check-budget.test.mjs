// The privacy checker’s time on long input with no address in it: a regex that backtracks on repeated text would
// spend seconds there. Moved from fixtures-privacy.test.mjs, which is at its size ceiling.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkContentPrivacy } from '../tools/privacy-check.mjs';

test('privacy checker reads 200 KB with no address in well under a second, whatever it repeats', () => {
  for (const unit of ['a', '.', '-', '/', '\\', '1', '_', 'a.', 'a-', '-a']) {
    const text = unit.repeat(200_000 / unit.length);
    const started = performance.now();
    checkContentPrivacy(text);
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 100, `${JSON.stringify(unit)} took ${Math.round(elapsed)} ms`);
  }
});
