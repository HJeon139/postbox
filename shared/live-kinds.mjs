// The kinds of the `live` frame (designs/architecture/live-progress.md, “What reaches the browser”): a running turn’s
// progress, sent to the page unstored. Each kind mirrors the event types that carry the same data when it’s stored,
// and takes their public flag from EVENTS (shared/state.mjs), so there’s no second table of flags to drift. Each lists
// the only fields it may carry: server/public-state.mjs picks those and drops the rest, and fails closed for a kind
// that isn’t here or whose event types aren’t public.

/** A step’s fields, as turnStep shapes it (server/step-text.mjs): the only ones a frame carries of a step. */
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

/** A session’s fields that go live while its turn runs: the only ones a frame carries of a session. */
export const SESSION_FIELDS = Object.freeze(['toolCalls', 'toolCount', 'currentStep', 'glimpse', 'subagents']);

/**
 * Each kind: the event types it mirrors, which must all be public for it to be sent, and its fields. A field named in
 * `nested` is picked again by its own list.
 * @type {Readonly<Record<string, Readonly<{ events: readonly string[], fields: readonly string[], item: boolean }>>>}
 */
export const LIVE = Object.freeze({
  text: Object.freeze({ events: Object.freeze(['item.text']), fields: Object.freeze(['threadId', 'itemId', 'turnId', 'at', 'text']), item: true }),
  step: Object.freeze({ events: Object.freeze(['item.patch']), fields: Object.freeze(['threadId', 'itemId', 'turnId', 'rev', 'step']), item: true }),
  session: Object.freeze({ events: Object.freeze(['session.patch']), fields: Object.freeze(['sessionId', ...SESSION_FIELDS]), item: false }),
  snapshot: Object.freeze({
    events: Object.freeze(['item.text', 'item.patch', 'session.patch']),
    fields: Object.freeze(['turnId', 'sessionId', 'threadId', 'itemId', 'text', 'steps', 'session']),
    item: true,
  }),
});
