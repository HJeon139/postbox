// The model behind Postbox’s own cheap calls: a thread’s summary (server/thread-summary.mjs) and the quote check on a
// write the person asked for (server/write-intent.mjs). A module of its own, so neither imports the other for it (#653).

export const SUMMARY_MODEL = 'haiku';
