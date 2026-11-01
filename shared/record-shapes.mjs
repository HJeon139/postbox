// New-command validation. Recovery uses the frozen event interpreter, not these evolving admission rules.
import { LIMITS } from './limits.mjs';

export const RECORD_LIMITS = Object.freeze({ sourceBytes: 64 * 1024, turnBytes: 256 * 1024, dispatches: 4 });
export const ROUTES = ['next-tool-result', 'hook', 'native-input', 'new-turn'];
const common = ['schema', 'id', 'kind', 'conversationId', 'threadId', 'sourceId', 'version', 'rev', 'at', 'to', 'from', 'state'];
const askFields = ['askKind', 'title', 'summary', 'deliveryId'];
const deliveryFields = [
  'mode',
  'reason',
  'parts',
  'heldBy',
  'retryAsk',
  'notBefore',
  'attempt',
  'sentRev',
  'turnId',
  'dispatchId',
  'route',
  'target',
  'renderVersion',
];
export const attemptFields = ['attempt', 'sentRev', 'turnId', 'dispatchId', 'route', 'target'];

export function recordError(message) {
  return Object.assign(new Error(`The record was refused: ${message}`), { code: 'ERECORD' });
}

export function requireRecord(ok, message) {
  if (!ok) throw recordError(message);
}

const canonical = (value) =>
  JSON.stringify(value, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, v[k]]),
        )
      : v,
  );
export const equalRecordValue = (a, b) => canonical(a) === canonical(b);
export const recordBytes = (value) => new TextEncoder().encode(JSON.stringify(value)).length;
const id = (v) => typeof v === 'string' && v.length > 0 && v.length <= 256 && !['__proto__', 'constructor', 'prototype'].includes(v);
const integer = (v) => Number.isSafeInteger(v) && v > 0;

/** Refuse non-JSON objects, cycles, getters and oversized/deep values at the command boundary. */
function plain(value, depth = 0, seen = new Set()) {
  requireRecord(depth <= 16, 'the data is too deeply nested.');
  if (!value || typeof value !== 'object') {
    requireRecord(
      value === null || ['string', 'boolean'].includes(typeof value) || (typeof value === 'number' && Number.isFinite(value)),
      'use plain JSON data.',
    );
    return;
  }
  requireRecord(!seen.has(value), 'the data contains a cycle.');
  requireRecord(Array.isArray(value) || [Object.prototype, null].includes(Object.getPrototypeOf(value)), 'use plain JSON objects.');
  requireRecord(Object.getOwnPropertySymbols(value).length === 0, 'symbols are not JSON data.');
  if (Array.isArray(value)) requireRecord(Object.keys(value).length === value.length, 'supply dense JSON arrays.');
  seen.add(value);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    requireRecord(!descriptor.get && !descriptor.set, 'getters are not record data.');
    plain(descriptor.value, depth + 1, seen);
  }
  seen.delete(value);
}

function recipient(r) {
  requireRecord(r && id(r.persona) && (r.session === undefined || id(r.session)), 'name a persona and an optional session.');
  requireRecord(
    Object.keys(r).every((k) => ['persona', 'session'].includes(k)),
    'the recipient has unknown fields.',
  );
}

function deliveryShape(r) {
  recipient(r.to);
  requireRecord(['held', 'waiting', 'sent', 'blocked'].includes(r.state), 'the delivery state is unknown.');
  requireRecord(['wake', 'notify', 'interrupt'].includes(r.mode), 'the delivery mode is unknown.');
  requireRecord(Array.isArray(r.parts) && r.parts.length > 0 && r.parts.length <= 64, 'supply bounded canonical parts.');
  requireRecord(
    r.parts.every((p) => p && typeof p.text === 'string' && p.text.length <= LIMITS.longText),
    'each part needs bounded source text.',
  );
  requireRecord(recordBytes(r.parts) <= LIMITS.longText * 4, 'the source content is too large.');
  if (r.state === 'held') requireRecord(id(r.heldBy) && r.reason === 'held', 'a held delivery needs its ask.');
  else requireRecord(r.heldBy === undefined, 'only held deliveries name a holding ask.');
  if (r.state === 'blocked') requireRecord(id(r.retryAsk), 'a blocked delivery needs a retry ask.');
  else requireRecord(r.retryAsk === undefined, 'only blocked deliveries name a retry ask.');
  if (r.state === 'waiting') requireRecord(['busy', 'scheduled', 'resend', 'amendment', 'undo-window'].includes(r.reason), 'the waiting reason is unknown.');
  if (r.notBefore !== undefined) requireRecord(Number.isFinite(r.notBefore) && r.notBefore >= 0, 'the eligibility time is invalid.');
  if (r.attempt !== undefined) requireRecord(Number.isSafeInteger(r.attempt) && r.attempt >= 0, 'the attempt counter is invalid.');
  if (r.state === 'sent') sentShape(r);
  else
    requireRecord(
      (r.route ?? null) === null &&
        attemptFields.filter((f) => !['route', 'attempt'].includes(f)).every((f) => r[f] === undefined) &&
        r.renderVersion === undefined,
      'an unreserved delivery cannot keep an attempt.',
    );
}

function sentShape(r) {
  requireRecord(
    id(r.to.session) && integer(r.attempt) && integer(r.sentRev) && r.sentRev <= r.rev && id(r.turnId) && id(r.dispatchId),
    'the sent attempt is incomplete.',
  );
  requireRecord(ROUTES.includes(r.route) && r.renderVersion === 1, 'the route or renderer is unsupported.');
  const field = { 'next-tool-result': 'callId', hook: 'invocationId', 'native-input': 'inputId', 'new-turn': 'dispatchId' }[r.route];
  requireRecord(r.target && id(r.target[field]), 'the route target is incomplete.');
  requireRecord(
    Object.keys(r.target).every((k) => [field, 'hostId', 'hostTurnId', ...(r.route === 'native-input' ? ['backendRunId', 'inputMode'] : [])].includes(k)),
    'the target has unknown fields.',
  );
  requireRecord(
    Object.entries(r.target).every(([k, value]) => k === 'inputMode' || id(value)),
    'the target identities must be bounded strings.',
  );
  requireRecord((r.target.hostId === undefined) === (r.target.hostTurnId === undefined), 'a remote target needs both host identities.');
  if (r.route === 'native-input')
    requireRecord(
      id(r.target.backendRunId) && ['steer-active-turn', 'start-turn-in-live-execution'].includes(r.target.inputMode),
      'the native target needs its execution and input mode.',
    );
}

export function validateRecord(r) {
  plain(r);
  requireRecord(r && r.schema === 1 && ['ask', 'delivery'].includes(r.kind), 'the record schema or kind is unknown.');
  const allowed = [...common, ...(r.kind === 'ask' ? askFields : deliveryFields)];
  requireRecord(
    Object.keys(r).every((k) => allowed.includes(k)),
    'the record has unknown fields.',
  );
  requireRecord(
    ['id', 'conversationId', 'threadId', 'sourceId', 'from'].every((k) => id(r[k])),
    'record identities must be bounded strings.',
  );
  requireRecord(integer(r.version) && integer(r.rev) && Number.isFinite(r.at) && r.at >= 0, 'the revision, version or time is invalid.');
  if (r.kind === 'delivery') return deliveryShape(r);
  requireRecord(
    r.to === 'person' && r.state === 'open' && ['block', 'permission', 'toolask', 'hop', 'appsend', 'note', 'blocked'].includes(r.askKind),
    'the ask header is invalid.',
  );
  requireRecord(
    typeof r.title === 'string' &&
      r.title.length <= LIMITS.fallback &&
      (r.summary === undefined || (typeof r.summary === 'string' && r.summary.length <= LIMITS.fallback)),
    'the ask presentation is too large.',
  );
  if (r.askKind === 'blocked') requireRecord(id(r.deliveryId), 'a blocked ask needs its delivery.');
}
