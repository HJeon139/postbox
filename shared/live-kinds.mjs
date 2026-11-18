// The kinds of the `live` frame (designs/architecture/live-progress.md, “What reaches the browser”): a running turn’s
// progress, sent to the page unstored. Each kind mirrors the event types that carry the same data when it’s stored,
// and takes their public flag from EVENTS (shared/state.mjs), so there’s no second table of flags to drift; and it
// names the state keys its data belongs to, which must be public too (PUBLIC_STATE_KEYS). Each kind’s shape lists the
// only fields it may carry, all the way down: server/public-state.mjs keeps a field only as a scalar (a string, a
// number, a boolean or null), or as an object or a list whose entries are picked by their own shape, and drops the
// rest, so a nested value can’t carry what its kind doesn’t list.

/**
 * A shape: the scalar fields kept, and the fields that hold an object or a list of them, each with its own shape.
 * @typedef {{ fields: readonly string[], objects?: Readonly<Record<string, Shape>>, lists?: Readonly<Record<string, Shape>> }} Shape
 */

/** A step’s fields, as turnStep shapes it (server/step-text.mjs): each a scalar. */
export const STEP_FIELDS = Object.freeze([
  'id',
  'label',
  'state',
  'ms',
  'who',
  'parent',
  'detail',
  'kind',
  'job',
  'input',
  'output',
  'part',
  'at',
  'added',
  'deleted',
  'diff',
]);

/** A tool call on a session, as the turn reports it (server/turn-context.mjs). */
export const TOOL_CALL_FIELDS = Object.freeze(['name', 'state', 'ms']);

/** A subagent on a session, as the turn reports it (server/turn-context.mjs, status). */
export const SUBAGENT_FIELDS = Object.freeze(['id', 'name', 'state', 'ctx', 'doing', 'thinking', 'asked', 'said', 'since', 'parent', 'bg']);

/** A session’s fields that go live while its turn runs. */
export const SESSION_FIELDS = Object.freeze(['toolCalls', 'toolCount', 'currentStep', 'glimpse', 'subagents']);

/**
 * A session’s stored fields a session frame may carry beside its live ones: a running turn’s change of state or context,
 * stored as ever, rides on the frame sent with it, and its stored event isn’t sent to the page
 * (server/live-sent.mjs), so the change costs the wire one frame, as it did when the two were one patch.
 */
export const CARRIED_FIELDS = Object.freeze(['state', 'ctx', 'updatedAt']);

/** @type {Shape} */
const STEP = Object.freeze({ fields: STEP_FIELDS });
/** @type {Shape} */
const SESSION = Object.freeze({
  fields: Object.freeze(['toolCount', 'currentStep', 'glimpse']),
  lists: Object.freeze({ toolCalls: Object.freeze({ fields: TOOL_CALL_FIELDS }), subagents: Object.freeze({ fields: SUBAGENT_FIELDS }) }),
});

/**
 * Each kind: the event types it mirrors and the state keys its data belongs to, all of which must be public for it to
 * be sent; whether it’s an item’s, which goes only to a stream with its conversation open; and its shape.
 * @type {Readonly<Record<string, Readonly<{ events: readonly string[], keys: readonly string[], item: boolean, shape: Shape, positional?: boolean }>>>}
 */
export const LIVE = Object.freeze({
  text: Object.freeze({
    events: Object.freeze(['item.text']),
    keys: Object.freeze(['items']),
    item: true,
    shape: Object.freeze({ fields: Object.freeze(['threadId', 'itemId', 'at', 'text']) }),
    // One goes for each delta of a running reply’s words, so it goes as a list of its fields in this order (wireOf).
    positional: true,
  }),
  step: Object.freeze({
    events: Object.freeze(['item.patch']),
    keys: Object.freeze(['items']),
    item: true,
    shape: Object.freeze({ fields: Object.freeze(['threadId', 'itemId', 'rev']), objects: Object.freeze({ step: STEP }) }),
  }),
  session: Object.freeze({
    events: Object.freeze(['session.patch']),
    keys: Object.freeze(['sessions']),
    item: false,
    shape: Object.freeze({ fields: Object.freeze(['sessionId', ...SESSION.fields, ...CARRIED_FIELDS]), lists: SESSION.lists }),
  }),
  snapshot: Object.freeze({
    events: Object.freeze(['item.text', 'item.patch', 'session.patch']),
    keys: Object.freeze(['items', 'sessions']),
    item: true,
    shape: Object.freeze({
      fields: Object.freeze(['turnId', 'sessionId', 'threadId', 'itemId']),
      objects: Object.freeze({ text: Object.freeze({ fields: Object.freeze(['itemId', 'at', 'text']) }), session: SESSION }),
      lists: Object.freeze({ steps: STEP }),
    }),
  }),
});

/**
 * A live frame’s data as the stream sends it, once its kind’s shape has picked it (server/public-state.mjs): a kind sent
 * for each delta (`positional`) goes as `[kind, ...its fields in its shape’s order]`, which costs a delta less than
 * main’s numbered item.text did; any other as its object. Only the encoding differs: what’s in it is the pick’s.
 * @param {Record<string, any>} data
 */
export function wireOf(data) {
  const def = LIVE[data.kind];
  return def?.positional ? [data.kind, ...def.shape.fields.map((k) => data[k] ?? null)] : data;
}

/**
 * A live frame’s data as received: a positional one read back to its object by its kind’s fields (wireOf), a list of
 * any other kind to null, and an object as it is. @param {any} data
 */
export function liveFrameOf(data) {
  if (!Array.isArray(data)) return data;
  const def = Object.hasOwn(LIVE, data[0]) ? LIVE[data[0]] : null;
  if (!def?.positional) return null;
  // A field the pick left out goes as null, and comes back left out.
  return Object.fromEntries([['kind', data[0]], ...def.shape.fields.flatMap((k, i) => (data[i + 1] === null ? [] : [[k, data[i + 1]]]))]);
}
