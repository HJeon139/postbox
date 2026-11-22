// The receipt on a review the agent revised after the person answered it (#518): what they answered, for which
// revision, and when, and that the agent has revised it since. Without it, an approval of an earlier draft
// vanished when the draft changed, and the person couldn’t tell whether it counted.

import { h, timeOf } from './dom.mjs';

const VERDICT_WORDS = { approve: 'approved', request_changes: 'asked for changes to', comment: 'commented on' };
/** What the person did, by the verdict saved with the answer: an own key only, never one an object inherits. */
const verdictWord = (v) => (Object.hasOwn(VERDICT_WORDS, v) ? VERDICT_WORDS[v] : 'answered');

/**
 * The receipt, or null when the block has no earlier answer or is answered again.
 * @param {any} item  the review’s item
 */
export function answerReceipt(item) {
  const prior = item.priorAnswer;
  if (!prior || item.answered) return null;
  const did = prior.action === 'dismiss' ? 'dismissed' : verdictWord(prior.verdict);
  return h(
    // Quiet, not an alarm: it reports what happened, and the review below is how to act on it.
    'div.callout.quiet.rv-receipt',
    { role: 'status' },
    h('span', `You ${did} revision ${prior.revision} at ${timeOf(prior.at)}. The agent has revised it since.`),
  );
}
