import assert from 'node:assert/strict';
import { test } from 'node:test';
import { publicEvent, publicState } from '../server/public-state.mjs';
import { onStoreEvent, snapshotOf } from '../server/remote/turns-snapshot.mjs';
import { keepEvent } from '../server/room-events.mjs';
import { apply, emptyState } from '../shared/state.mjs';
import { change, delivery } from './records-fixture.mjs';

const privateRecord = { id: 'rec_private', to: { persona: 'someone_else' }, parts: [{ text: 'private words' }] };

test('the HTTP projection omits all private collections without changing snapshot state', () => {
  const state = {
    ...emptyState(),
    records: { rec_private: privateRecord },
    dispatches: { d: privateRecord },
    pins: { p: 'private words' },
    receipts: [{ id: 'rec_private' }],
    receiptCheckpoint: { seq: 3 },
  };
  apply(state, 'record', change('open', delivery('seeded', { parts: [{ text: 'seeded private words' }] })).data);
  const visible = publicState(state);
  assert.doesNotMatch(JSON.stringify(visible), /private|records|dispatches|pins|receipts|receiptCheckpoint/);
  assert.equal(state.records.rec_private, privateRecord);
  assert.equal(visible.threads, state.threads, 'projection does not copy or change unrelated collections');
});

test('private projections preserve seq and ordinary events without accepting private fields as cursors', () => {
  const ev = { seq: 9, type: 'record.close', data: { ...privateRecord, final: 'withdrawn' } };
  assert.deepEqual(publicEvent(ev), { seq: 9, type: 'cursor', data: {} });
  const publicEv = { seq: 10, type: 'item.patch', data: { id: 'i', text: 'visible' } };
  assert.equal(publicEvent(publicEv), publicEv);
  assert.equal(ev.data.parts[0].text, 'private words');
});

test('telemetry and host snapshots exclude another recipient’s undelivered records', () => {
  assert.equal(keepEvent(1, 'record', { record: privateRecord }), null);
  assert.equal(keepEvent(2, 'record.close', { id: privateRecord.id }), null);
  const rts = {
    rt: { s: { ...emptyState(), records: { rec_private: privateRecord } }, conversationThreads: () => ['t'], store: { items: () => [] } },
    live: new Map([['s', { sessionId: 's' }]]),
    dirty: new Map(),
  };
  assert.deepEqual(snapshotOf(rts, { id: 's', threadId: 't' }), { home: 't', threads: [{ id: 't', items: [] }] });
  onStoreEvent(rts, { seq: 1, type: 'record', data: { record: privateRecord } });
  onStoreEvent(rts, { seq: 2, type: 'record.close', data: { id: privateRecord.id } });
  assert.equal(rts.dirty.size, 0, 'private events cannot schedule a remote update');
});
