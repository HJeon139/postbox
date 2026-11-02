// Validate a prospective record group before the writer numbers anything. This never mutates published state.
import { applyRecordEvent, sameAttempt } from './record-events.mjs';
import { attemptFields, equalRecordValue, RECORD_LIMITS, recordBytes, requireRecord, validateRecord } from './record-shapes.mjs';

const get = (s, id) => (Object.hasOwn(s.records ?? {}, id) ? s.records[id] : undefined);
const recipientKey = (r) => (r.kind === 'ask' ? ['person'] : [r.to.persona, r.to.session ?? null]);
const same = (a, b, fields) => fields.every((f) => equalRecordValue(a[f], b[f]));

function changeAllowed(old, next, operation, data) {
  requireRecord(
    next.version === old.version + 1 && same(old, next, ['id', 'kind', 'conversationId', 'threadId', 'from', 'at']),
    'the version or owner changed.',
  );
  requireRecord(operation === 'bind' || same(old, next, ['to', 'sourceId']), 'binding needs an explicit bind operation.');
  if (operation === 'revise') {
    requireRecord(same(old, next, ['heldBy', 'retryAsk']), 'a revision cannot change the holding owner.');
    requireRecord(next.rev === old.rev + 1 && next.state === old.state, 'a revision cannot change the lifecycle.');
    if (old.state === 'sent') requireRecord(same(old, next, [...attemptFields, 'renderVersion']), 'a revision cannot change the frozen attempt.');
    return;
  }
  requireRecord(next.rev === old.rev && equalRecordValue(next.parts, old.parts), 'this transition cannot edit content.');
  if (operation !== 'reserve') requireRecord((next.attempt ?? 0) === (old.attempt ?? 0), 'only reservation advances the attempt counter.');
  if (operation === 'bind') {
    requireRecord(same(old, next, ['heldBy', 'retryAsk']), 'binding cannot change the holding owner.');
    requireRecord(next.sourceId === old.sourceId || old.sourceId === old.id, 'a posted source cannot be re-keyed.');
    requireRecord(
      old.kind === 'delivery' &&
        ['held', 'waiting'].includes(old.state) &&
        next.state === old.state &&
        next.to.persona === old.to.persona &&
        (!old.to.session || next.to.session === old.to.session),
      'the recipient cannot be rebound.',
    );
  } else if (operation === 'release') {
    requireRecord(['held', 'blocked'].includes(old.state) && next.state === 'waiting', 'only held or blocked deliveries release.');
  } else if (operation === 'reserve') {
    requireRecord(
      old.state === 'waiting' && next.state === 'sent' && next.sentRev === old.rev && next.attempt === (old.attempt ?? 0) + 1,
      'only a waiting current revision with the next attempt can be reserved.',
    );
  } else if (operation === 'requeue') {
    requireRecord(old.state === 'sent' && next.state === 'waiting' && sameAttempt(old, data.attemptIdentity), 'requeue needs the exact retired attempt.');
    if (data.final !== undefined) requireRecord(data.final === 'delivered' && Number.isFinite(data.at), 'the acknowledgment outcome is invalid.');
  } else if (operation === 'block') {
    requireRecord(old.state === 'waiting' && next.state === 'blocked', 'only waiting deliveries become blocked.');
  } else requireRecord(false, 'the transition operation is unknown.');
}

function checkEvent(state, event) {
  const d = event.data;
  requireRecord(d && typeof d === 'object', 'the event data is missing.');
  const old = get(state, event.type === 'record' ? d.record?.id : d.id);
  if (event.type === 'record') {
    validateRecord(d.record);
    if (d.operation === 'open') {
      requireRecord(
        !old &&
          d.previousVersion === 0 &&
          d.record.version === 1 &&
          (d.record.attempt ?? 0) === 0 &&
          (d.record.kind === 'ask' || ['held', 'waiting'].includes(d.record.state)),
        'opening requires a new unreserved record.',
      );
    } else {
      if (!old || old.version !== d.previousVersion) return 'stale';
      if (old.state === 'sent' && ['requeue', 'block'].includes(d.operation) && !sameAttempt(old, d.attemptIdentity)) return 'stale';
      changeAllowed(old, d.record, d.operation, d);
    }
  } else {
    if (!old || old.version !== d.previousVersion || (old.state === 'sent' && !sameAttempt(old, d.attemptIdentity))) return 'stale';
    requireRecord(
      ['delivered', 'answered', 'expired', 'withdrawn', 'superseded'].includes(d.final) && Number.isFinite(d.at),
      'the close outcome or time is invalid.',
    );
    if (['expired', 'withdrawn', 'superseded'].includes(d.final))
      requireRecord(typeof d.reason === 'string' && d.reason.trim().length > 0, 'the terminal reason is missing.');
    if (d.final === 'answered') requireRecord(old.kind === 'ask', 'only asks are answered.');
    if (d.final === 'delivered') requireRecord(old.kind === 'delivery' && old.state === 'sent' && old.sentRev === old.rev, 'a newer amendment is still owed.');
  }
  return 'accepted';
}

function integrity(state) {
  const keys = new Set();
  for (const r of Object.values(state.records)) {
    const key = JSON.stringify([r.conversationId, r.kind, recipientKey(r), r.sourceId]);
    requireRecord(!keys.has(key), 'the addressed source already has an owner.');
    keys.add(key);
    const linked = r.state === 'held' ? r.heldBy : r.state === 'blocked' ? r.retryAsk : null;
    if (linked) {
      const a = get(state, linked);
      requireRecord(
        a?.kind === 'ask' && a.conversationId === r.conversationId && (r.state !== 'blocked' || (a.askKind === 'blocked' && a.deliveryId === r.id)),
        'a delivery has no matching open ask in its conversation.',
      );
    }
    if (r.kind === 'ask' && r.askKind === 'blocked')
      requireRecord(get(state, r.deliveryId)?.retryAsk === r.id, 'a retry ask has no matching blocked delivery.');
  }
  pinLimits(state);
}

function pinLimits(state) {
  const turns = new Map();
  for (const manifest of Object.values(state.dispatches)) {
    const key = JSON.stringify([manifest.to.persona, manifest.to.session, manifest.turnId]);
    const total = turns.get(key) ?? { bytes: 0, count: 0 };
    total.count++;
    for (const entry of manifest.entries) {
      const r = get(state, entry.recordId);
      requireRecord(
        manifest.settledIds?.includes(entry.recordId) ||
          (r?.state === 'sent' && r.dispatchId === manifest.id && same(r, manifest, ['to', 'turnId', 'route', 'target', 'renderVersion'])),
        'a dispatch has conflicting owners.',
      );
      const bytes = recordBytes(entry.parts);
      requireRecord(bytes <= RECORD_LIMITS.sourceBytes, 'a pinned source exceeds the byte ceiling.');
      total.bytes += bytes;
    }
    requireRecord(total.count <= RECORD_LIMITS.dispatches && total.bytes <= RECORD_LIMITS.turnBytes, 'the recipient turn has too many unresolved pins.');
    turns.set(key, total);
  }
}

/** Public events may accompany record transitions; their existing owner still validates them. */
export function buildRecordBatch(state, events) {
  const candidate = {
    records: Object.assign(Object.create(null), structuredClone(state.records ?? {})),
    dispatches: Object.assign(Object.create(null), structuredClone(state.dispatches ?? {})),
  };
  const accepted = [];
  const publishedDispatches = new Set(Object.keys(state.dispatches ?? {}));
  for (const event of events) {
    if (!['record', 'record.close'].includes(event.type)) {
      requireRecord(!(event.type === 'remove' && ['record', 'records'].includes(event.data?.kind)), 'records require an explicit close.');
      accepted.push(event);
      continue;
    }
    requireRecord(
      Object.keys(event.data ?? {}).every((key) =>
        (event.type === 'record'
          ? ['operation', 'previousVersion', 'record', 'attemptIdentity', 'final', 'at']
          : ['id', 'previousVersion', 'final', 'at', 'reason', 'attemptIdentity']
        ).includes(key),
      ),
      'the lifecycle event has unknown fields.',
    );
    if (checkEvent(candidate, event) === 'stale') return { outcome: 'stale', events: [] };
    if (event.type === 'record' && event.data.operation === 'reserve')
      requireRecord(!publishedDispatches.has(event.data.record.dispatchId), 'a published manifest cannot gain entries.');
    applyRecordEvent(candidate, event.type, event.data);
    accepted.push(structuredClone(event));
  }
  integrity(candidate);
  return { outcome: accepted.length ? 'applied' : 'noop', events: accepted };
}
