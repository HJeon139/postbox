// The permission modes’ names and words, which the permissions panel (app/js/permissions.mjs, which re-exports them)
// uses. /mode, /model and /effort open the persona sheet now, the one place a persona’s settings are edited.

// The same names and words as the persona sheet’s Permissions field (sheets.mjs).
export const MODES = [
  ['auto', 'Auto', 'A safety check approves routine actions; it asks you only when it can’t decide.'],
  ['ask', 'Ask me', 'It asks before running commands or changing files.'],
  ['acceptEdits', 'Accept edits', 'It edits files in its folders freely, and asks before running commands.'],
  ['bypass', 'Run everything', 'It never asks. Use it only in a folder you can lose.'],
];
