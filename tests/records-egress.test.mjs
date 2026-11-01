import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { setStreamTap } from '../server/adapters/setup.mjs';
import { buildRecordBatch } from '../shared/record-batch.mjs';
import { change, delivery } from './records-fixture.mjs';
import { filesUnder, setup } from './telemetry-fixture.mjs';

test('a private record accepted by the Store writes neither a telemetry event nor a backend stream line', () => {
  const f = setup({ record: true });
  const before = filesUnder(f.data).map((path) => [path, readFileSync(join(f.data, path), 'utf8')]);
  let taps = 0;
  const off = setStreamTap(f.rt, () => taps++);
  try {
    const ev = change('open', delivery('private_record', { conversationId: f.t.id, threadId: f.t.id, parts: [{ text: 'recipient-only private payload' }] }));
    const { events } = buildRecordBatch(f.store.state, [ev]);
    for (const e of events) f.store.emit(e.type, e.data);
    assert.ok(f.store.state.records.rec_private_record);
    assert.equal(taps, 0);
    assert.deepEqual(
      filesUnder(f.data).map((path) => [path, readFileSync(join(f.data, path), 'utf8')]),
      before,
    );
  } finally {
    off();
    f.stop();
  }
});
