// Small text helpers shared by the server and the browser.

import { renderMarkdown, TABLE_SEP } from './markdown.mjs';

/** Text on one line, cut to n characters with an ellipsis. */
export const clip = (s, n = 240) => {
  const t = String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

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
 * The agent a message addresses by name without its @, as in “critic: what’s your concern?”: Postbox sends a message
 * that @-mentions no one to the agent that spoke last, so this one may not reach the critic. Only a name that opens
 * the message, followed by “:” or “,”, counts: “what did the researcher find?” is meant for whoever spoke last.
 * Nothing when the message @-mentions anyone (read as parseMentions, above, reads them), or when the agent
 * it names spoke last, since the message reached it anyway.
 * @param {string} text  @param {string[]} handles  @param {{ lastSpeaker?: string|null }} [opts]  the last speaker’s handle
 * @returns {string[]}
 */
export function unaddressed(text, handles, { lastSpeaker = null } = {}) {
  if (parseMentions(text, handles).length) return [];
  const name = /^\s*([A-Za-z0-9_-]+)\s*[:,]/.exec(String(text ?? ''))?.[1]?.toLowerCase();
  const h = handles.find((x) => x.toLowerCase() === name);
  return h && h !== lastSpeaker ? [h] : [];
}

/**
 * Splits streaming text into finished sentences for a polite live region, so a screen reader hears
 * whole sentences instead of every token. A sentence ends at a line break, or at . ! or ? (with any closing quote,
 * bracket or Markdown mark after it) followed by whitespace or the end of the text, so the dots in converter.py,
 * 6.21371 and v0.13.0 stay inside their sentence, as does “e.g.” (#196). A fenced code block is one piece.
 * @param {string} text       everything streamed so far
 * @param {number} spoken     how many characters were already announced
 * @param {boolean} [done]    true when the reply has ended, which finishes the last sentence
 * @returns {{ sentences: string[], spoken: number }}
 */
export function finishedSentences(text, spoken, done = false) {
  const r = pieces(text, spoken, done);
  return { sentences: r.pieces.map((s) => s.replace(/\s+/g, ' ')), spoken: r.spoken };
}

/** The finished pieces of text after spoken, as written: sentences, and code blocks whole. @param {string} text @param {number} spoken @param {boolean} done */
function pieces(text, spoken, done) {
  const rest = text.slice(spoken);
  const out = [];
  let consumed = 0;
  for (let end = nextEnd(rest, 0); end > -1; end = nextEnd(rest, consumed)) {
    // A sentence counts as finished only once something follows it, or the reply is done.
    if (end >= rest.length && !done) break;
    const s = rest.slice(consumed, end).trim();
    if (s) out.push(s);
    consumed = end;
  }
  if (done) {
    const tail = rest.slice(consumed).trim();
    if (tail) out.push(tail);
    consumed = rest.length;
  }
  return { pieces: out, spoken: spoken + consumed };
}

const END = /[.!?]+["”’)\]*_`~]*(?=\s|$)|\n+/g;
// Not an end: the last dot of single letters and dots (e.g., i.e.), or a numbered list item’s marker.
const NOT_END = /(?:^|[^\w.])(?:\w\.){2,}["”’)\]*_`~]*$|^\s*\d{1,9}[.)]$/;
/** Where the sentence that starts at rest[from] ends, or -1 when it hasn’t yet. @param {string} rest @param {number} from */
function nextEnd(rest, from) {
  // A fence opens a line, and its info string has no backtick: “```x``` is the tool.” is prose. One inside a list
  // item is indented, and so is its close.
  const fence = /^(\s*)(`{3,}|~{3,})[^`\n]*\n/.exec(rest.slice(from));
  if (fence && (from === 0 || rest[from - 1] === '\n' || fence[1].includes('\n'))) {
    const body = from + fence[0].length;
    const close = new RegExp(`^[ \\t]*${fence[2][0]}{${fence[2].length},}[ \\t]*$`, 'm').exec(rest.slice(body));
    return close ? body + close.index + close[0].length : -1;
  }
  END.lastIndex = from;
  for (let m = END.exec(rest); m; m = END.exec(rest)) {
    const end = m.index + m[0].length;
    const s = rest.slice(from, end);
    // Nor inside a link’s text: “[see this. And that](…)” is one link.
    if (m[0][0] === '\n' || (!NOT_END.test(s) && s.split('[').length <= s.split(']').length)) return end;
  }
  return -1;
}

/**
 * finishedSentences as a screen reader should hear them: plain text, as the Markdown renderer draws it, with no code
 * ticks, emphasis or heading marks, list bullets or link addresses (#196). A code block isn’t read out.
 * @param {string} text @param {number} spoken @param {boolean} [done]
 */
export function spokenSentences(text, spoken, done = false) {
  const r = pieces(text, spoken, done);
  return { sentences: r.pieces.map(plainText).filter(Boolean), spoken: r.spoken };
}

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
/** Markdown as plain text: the text the renderer draws, without code blocks. @param {string} src */
export function plainText(src) {
  // A table arrives a line at a time: a row is heard as its cells, and its delimiter row not at all.
  if (TABLE_SEP.test(src)) return '';
  const row = /^\s*\|(.*)\|\s*$/.exec(src);
  if (row) return row[1].split('|').map(plainText).filter(Boolean).join(', ');
  return (
    renderMarkdown(String(src).replace(/<\/?(details|summary)>/g, ' '))
      .replace(/<pre[\s\S]*?<\/pre>/g, ' ')
      // A sentence cut out of the middle of bold or code keeps a mark the renderer couldn’t pair; code keeps its own.
      .split(/(<code>[\s\S]*?<\/code>)/)
      .map((part, i) => (i % 2 ? part : part.replace(/\*\*|__|~~|`/g, '')))
      .join('')
      .replace(/<(br|hr|\/p|\/li|\/h\d|\/blockquote|\/div|\/t[dh])>/g, ' ')
      .replace(/<[^>]+>/g, '')
      .replace(/&(amp|lt|gt|quot|#39);/g, (e) => ENTITIES[e])
      .replace(/\s+/g, ' ')
      .trim()
  );
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
