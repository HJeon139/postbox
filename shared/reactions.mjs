// The reactions the person can make on a message, block or app (#251), with what each one says: the server checks a
// reaction against these (server/reactions.mjs), and the page offers them (app/js/reactions.mjs).

export const REACTIONS = Object.freeze([
  ['👍', 'Good'],
  ['👎', 'Not good'],
  ['🚩', 'Flag this'],
  ['❓', 'Unclear'],
  ['✅', 'Done'],
]);
