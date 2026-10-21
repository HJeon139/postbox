// Small text helpers shared by the server and the browser.

/**
 * The agents a message @-mentions, in order, without duplicates.
 * Mentions inside code are ignored, and "name@example.com" is not a mention.
 * @param {string} text
 * @param {string[]} handles  known handles, without the @
 */
export function parseMentions(text, handles) {
  const known = new Map(handles.map((h) => [h.toLowerCase(), h]));
  const plain = String(text ?? '')
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/`[^`]*`/g, ' ');
  const found = [];
  for (const m of plain.matchAll(/(^|[^\w@.])@([A-Za-z0-9_-]+)/g)) {
    const h = known.get(m[2].toLowerCase());
    if (h && !found.includes(h)) found.push(h);
  }
  return found;
}

/**
 * Splits streaming text into finished sentences for a polite live region, so a screen reader hears
 * whole sentences instead of every token.
 * @param {string} text       everything streamed so far
 * @param {number} spoken     how many characters were already announced
 * @param {boolean} [done]    true when the reply has ended, which finishes the last sentence
 * @returns {{ sentences: string[], spoken: number }}
 */
export function finishedSentences(text, spoken, done = false) {
  const rest = text.slice(spoken);
  const sentences = [];
  let consumed = 0;
  const re = /[^.!?\n]*(?:[.!?]+["”’)\]]*|\n+)(?=\s|$)/g;
  let m;
  while ((m = re.exec(rest))) {
    if (!m[0]) {
      re.lastIndex++;
      continue;
    }
    const end = m.index + m[0].length;
    // A sentence counts as finished only once something follows it, or the reply is done.
    if (end >= rest.length && !done) break;
    const s = m[0].replace(/\s+/g, ' ').trim();
    if (s) sentences.push(s);
    consumed = end;
  }
  if (done) {
    const tail = rest.slice(consumed).replace(/\s+/g, ' ').trim();
    if (tail) sentences.push(tail);
    consumed = rest.length;
  }
  return { sentences, spoken: spoken + consumed };
}

/** “3 min”, “2 s”, “1 h 5 min”: durations as Postbox shows them. */
export function formatDuration(ms) {
  if (ms < 1000) return `${(ms / 1000).toFixed(1)} s`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
}
