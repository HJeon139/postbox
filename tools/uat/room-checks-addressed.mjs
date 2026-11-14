// #1328’s check: an agent answered a request the person sent to another agent, which it read in its catch-up. A request
// says so in a way a check can read: it asks for a code word (“End your reply with the code word KESTREL.”), and an
// agent the person didn’t write to that ends its reply with the word answered it. The addressed scenario’s requests
// carry one each (tests/uat/e2e/scenarios/addressed.md). Part of tools/uat/room-checks.mjs’s CHECKS.
import { parseMentions } from '../../shared/text.mjs';
import { itemsOf } from './room-items.mjs';

const CODE_WORD = /code word\W{0,3}([A-Z]{4,})\b/g;

/**
 * Whether a reply ends with a code word, as the request asks (“End your reply with the code word …”). A word quoted
 * earlier, as from a list another agent handed over, isn’t an answer to the request.
 * @param {unknown} text @param {string} word
 */
const endsWith = (text, word) => new RegExp(`\\b${word}\\W*$`).test(String(text ?? '').trim());

/** The code words a message of the person’s asks for. @param {string} text */
const codeWords = (text) => [...String(text ?? '').matchAll(CODE_WORD)].map((m) => m[1]);

/**
 * Who a message of the person’s went to: the handles it kept (#1328), or, for one from before, as Postbox routed it:
 * the agents it @-mentions, else the last agent to speak in its thread.
 * @param {any} it  a user item @param {any[]} before  the items before it in its thread @param {string[]} handles
 */
function recipientsOf(it, before, handles) {
  if (Array.isArray(it.to)) return it.to;
  const mentioned = parseMentions(it.text, handles);
  if (mentioned.length) return mentioned;
  const last = before.findLast((x) => x.kind === 'agent' && x.handle && String(x.text ?? '').trim());
  return last ? [last.handle] : [];
}

/** @param {any} facts */
function unaddressedAnswers(facts) {
  const handles = Object.values(facts.state?.personas ?? {}).map((/** @type {any} */ p) => p.handle);
  const items = itemsOf(facts);
  const out = [];
  items.forEach((it, i) => {
    if (it.kind !== 'user') return;
    const words = codeWords(it.text);
    if (!words.length) return;
    const to = recipientsOf(
      it,
      items.slice(0, i).filter((x) => x.threadId === it.threadId),
      handles,
    );
    for (const reply of items.slice(i + 1)) {
      if (reply.kind !== 'agent' || !reply.handle || to.includes(reply.handle)) continue;
      const said = words.find((w) => endsWith(reply.text, w));
      if (said) out.push({ it, reply, said, to });
    }
  });
  return out;
}

export const ADDRESSED_CHECKS = [
  {
    id: 'unaddressed-request-answered',
    inputs: ['state', 'threads'],
    issue: 1328,
    run: (/** @type {any} */ facts) =>
      unaddressedAnswers(facts).map(({ it, reply, said, to }) => ({
        key: `${it.id} ${reply.id}`,
        title: 'An agent answered the person’s request to another agent',
        evidence: `@${reply.handle} wrote the code word ${said} from the person’s request to ${to.map((h) => `@${h}`).join(', ') || 'no agent'} (${it.id}), in ${reply.id}.`,
      })),
  },
];
