// Messages given to one turn as a batch, in arrival order (#374, #733); a turn’s later segments are the same post.

// When each message waiting for an agent arrived, as a count (#733): `at` is a clock reading, and two messages can land
// in the same millisecond, so the order they’re given in breaks a tie by this, not by where each sat. In memory only:
// across a restart the clock has moved on, so a tie can’t span one.
let arrivals = 0;
/** The next arrival’s number. */
export const arrival = () => ++arrivals;
/** Earlier first: by the clock, then by arrival. @param {{ at?: number, seq?: number }} a @param {{ at?: number, seq?: number }} b */
export const byArrival = (a, b) => (a.at ?? 0) - (b.at ?? 0) || (a.seq ?? 0) - (b.seq ?? 0);

export const plainMessage = (message) => ['user', 'agent'].includes(message.kind) && !message.slash && !message.messages;

/** @param {any[]} messages */
export function combineMessages(messages) {
  const seen = new Set();
  const all = messages
    .flatMap((message) => message.messages ?? [message])
    .reverse()
    .filter((message) => {
      if (message.kind !== 'agent' || !message.itemId) return true;
      if (seen.has(message.itemId)) return false;
      seen.add(message.itemId);
      return true;
    })
    .reverse()
    .sort(byArrival);
  if (all.length === 1) return all[0];
  const last = all.at(-1);
  return {
    kind: all.some((message) => message.kind === 'user') ? 'user' : 'agent',
    from: last.from,
    text: all.map((message) => message.text ?? '').join('\n\n'),
    itemId: last.itemId,
    messages: all,
  };
}
