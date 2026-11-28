// Counting the conformance probe’s marker and guide in what Codex saved or sent (#585): the shared helpers of the
// request check (fake-responses.mjs) and the rollout check (rollout.mjs).

/**
 * The texts of the developer messages among Responses input items, one per content part. A rollout’s message
 * payload has the same shape.
 * @param {any[]} items @returns {string[]}
 */
export const developerTexts = (items) =>
  items
    .filter((item) => item?.type === 'message' && item.role === 'developer')
    .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
    .map((part) => (typeof part?.text === 'string' ? part.text : ''));

/** How many times `needle` is in `text`. @param {string} text @param {string} needle */
export const occurrences = (text, needle) => (needle ? text.split(needle).length - 1 : 0);
