// A1a installs no production producer. A1b must enable this gate with its receipt checkpoint and format guard.
import { buildRecordBatch } from '../shared/record-batch.mjs';

export const RECORD_PRODUCERS_ENABLED = false;

/** The lifecycle owner's only production commit entry. No opId shortcut can bypass the captured outcome. */
export async function commitRecords(store, build) {
  if (!RECORD_PRODUCERS_ENABLED)
    throw Object.assign(new Error('Record producers are disabled until durable receipts and migration guards are installed.'), { code: 'ERECORDDISABLED' });
  let outcome = 'stale';
  await store.commit((state) => {
    const batch = buildRecordBatch(state, build(state));
    outcome = batch.outcome;
    return batch.events;
  });
  return { outcome };
}
