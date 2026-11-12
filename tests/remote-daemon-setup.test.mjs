// The daemon tests’ done() waits for the daemon’s close before it removes the host home: a write the broker started
// before the close lands first, so the removal doesn’t race it into ENOTEMPTY, or leave what it wrote behind.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { sleep } from './remote-broker-fixtures.mjs';
import { setup } from './remote-daemon-setup.mjs';

test('done removes the home only after the broker’s close has settled its writes', async (t) => {
  /** @type {ReturnType<typeof setup>} */
  let s;
  /** @type {Promise<void> | undefined} */
  let closed;
  const broker = {
    close() {
      // A write started before the close, landing a moment after it.
      closed = sleep(10).then(() => {
        mkdirSync(join(s.home, 'late'), { recursive: true });
        writeFileSync(join(s.home, 'late', 'record'), 'x');
      });
      return closed;
    },
  };
  s = setup({ broker });
  t.after(() => rmSync(s.home, { recursive: true, force: true }));
  await s.done();
  await closed;
  assert.equal(existsSync(s.home), false, 'the home is gone, with nothing written into it after');
});
