// Schema-1 event interpretation is shared by live Store application and replay. Admission policy is separate.
import { attemptFields, equalRecordValue } from './record-shapes.mjs';

export const attemptIdentity = (r) => Object.fromEntries(['to', ...attemptFields].map((key) => [key, structuredClone(r[key])]));
export const sameAttempt = (r, identity) => !!identity && equalRecordValue(attemptIdentity(r), identity);
const own = (map, id) => (map && Object.hasOwn(map, id) ? map[id] : undefined);

/** Returns accepted/stale, never invokes command validation, clocks or external state. */
export function applyRecordEvent(state, type, data) {
  const records = (state.records ??= Object.create(null));
  const dispatches = (state.dispatches ??= Object.create(null));
  const id = type === 'record' ? data.record.id : data.id;
  const old = own(records, id);
  if (type === 'record') {
    const next = data.record;
    if (next.schema !== 1) throw new Error(`Unsupported record event schema: ${next.schema}`);
    if (data.operation === 'open' ? !!old : !old || old.version !== data.previousVersion) return 'stale';
    if (['requeue', 'block'].includes(data.operation) && old?.state === 'sent' && !sameAttempt(old, data.attemptIdentity)) return 'stale';
    if (old?.state === 'sent' && next.state !== 'sent') unpin(dispatches, old);
    if (data.operation === 'reserve') {
      const manifest = (dispatches[next.dispatchId] ??= {
        id: next.dispatchId,
        to: structuredClone(next.to),
        turnId: next.turnId,
        route: next.route,
        target: structuredClone(next.target),
        renderVersion: next.renderVersion,
        entries: [],
      });
      manifest.entries.push({ recordId: id, sentRev: next.sentRev, attempt: next.attempt, parts: structuredClone(next.parts), from: next.from, at: next.at });
    }
    records[id] = structuredClone(next);
    return 'accepted';
  }
  if (!old || old.version !== data.previousVersion || (old.state === 'sent' && !sameAttempt(old, data.attemptIdentity))) return 'stale';
  if (old.state === 'sent') unpin(dispatches, old);
  delete records[id];
  return 'accepted';
}

function unpin(dispatches, record) {
  const manifest = own(dispatches, record.dispatchId);
  if (!manifest) return;
  manifest.entries = manifest.entries.filter((entry) => entry.recordId !== record.id);
  if (!manifest.entries.length) delete dispatches[record.dispatchId];
}
