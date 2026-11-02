import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commitRecords, RECORD_PRODUCERS_ENABLED } from '../server/record-commands.mjs';

test('the disabled producer gate refuses before constructing or submitting any lifecycle operation', async () => {
  assert.equal(RECORD_PRODUCERS_ENABLED, false);
  let constructed = 0,
    submitted = 0;
  for (const operation of ['open', 'revise', 'bind', 'release', 'reserve', 'requeue', 'block', 'close']) {
    await assert.rejects(
      commitRecords({ commit: () => submitted++ }, () => {
        constructed++;
        return [{ type: operation }];
      }),
      { code: 'ERECORDDISABLED' },
    );
  }
  assert.equal(constructed, 0);
  assert.equal(submitted, 0);
});
