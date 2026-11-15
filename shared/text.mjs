// Small text helpers shared by the server and the browser.

import { GLIMPSE_CHARS, GLIMPSE_SOURCE_CHARS } from './limits.mjs';
import { renderMarkdown, TABLE_SEP } from './markdown.mjs';
import { stripTags } from './markdown-inline.mjs';
import { partEnd } from './text-parts.mjs';

/** How many words a text has, by the spaces between them. @param {string} s */
export const wordCount = (s) =>
  String(s ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;

/** Text on one line, cut to n characters with an ellipsis, never inside a surrogate pair (partEnd, #1052). */
export const clip = (s, n = 240) => {
  const t = String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > n ? `${t.slice(0, partEnd(t, n - 1))}…` : t;
};

/** A Markdown blockquote line: what it holds is someone else’s words. */
const BLOCKQUOTE = /^ {0,3}>/;
/** A line that starts with an item’s id, in brackets or not, alone or as a list item. */
const STARTS_WITH_ID = /^\s*(?:(?:[-*]|\d+\.)\s+)?\[?(it_[A-Za-z0-9]+)\]?/;
/** The first mention in a line, as parseMentions reads one. */
const FIRST_MENTION = /(?:^|[^\w@.])(@[A-Za-z0-9_-]+)/;

/**
 * Whether a line is a copy of an item’s line, as Postbox gave it to an agent: it starts with that item’s id, and
 * from its first mention on it is the item’s own words. The caller’s isCopy knows the items, so a line that only
 * looks like one, with an id that isn’t an item’s or words the item doesn’t hold, is the message’s own and wakes
 * (designs/rooms-at-scale.md, “Which mention wakes”).
 * @param {string} line @param {(itemId: string, said: string) => boolean} isCopy
 */
function copied(line, isCopy) {
  const id = STARTS_WITH_ID.exec(line)?.[1];
  if (!id) return false;
  // “You (@alpha): …” is how an agent’s own line reads to it.
  const plain = line.replace(/You \((@[A-Za-z0-9_-]+)\)/g, '$1');
  const at = FIRST_MENTION.exec(plain);
  if (!at) return false;
  return isCopy(id, plain.slice(at.index + at[0].length - at[1].length));
}

/**
 * A message’s text with what it quotes left out, so a mention there names an agent without waking it: code, blockquote
 * lines, and, for a caller that can tell one, lines copied from the conversation.
 * @param {string} text @param {((itemId: string, said: string) => boolean) | null} isCopy
 */
function unquoted(text, isCopy) {
  return String(text ?? '')
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .split('\n')
    .filter((line) => !BLOCKQUOTE.test(line) && !(isCopy && copied(line, isCopy)))
    .join('\n');
}

/**
 * The agents a message @-mentions, in order, without duplicates.
 * Mentions inside what the message quotes are ignored (unquoted, above), and "name@example.com" is not a mention.
 * @param {string} text
 * @param {string[]} handles  known handles, without the @
 * @param {((itemId: string, said: string) => boolean) | null} [isCopy]  whether `said`, a line from its first mention
 *   on, is the words of the item with that id. Without it, no line counts as copied from the conversation.
 */
export function parseMentions(text, handles, isCopy = null) {
  const known = new Map(handles.map((h) => [h.toLowerCase(), h]));
  const plain = unquoted(text, isCopy);
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

/** Keeps the raw tail needed to form a glimpse across streamed text pieces (#478). */
export const appendGlimpseSource = (source, piece) => `${source ?? ''}${piece ?? ''}`.slice(-GLIMPSE_SOURCE_CHARS);

/**
 * The latest one or two sentences an agent has streamed, starting at a sentence boundary and bounded for display (#478).
 * Only a bounded tail is scanned on each streaming update; its first partial sentence is discarded.
 * @param {string} text @param {number} [max]
 */
export function glimpseOf(text, max = GLIMPSE_CHARS) {
  const raw = String(text ?? '');
  let source = raw.slice(-GLIMPSE_SOURCE_CHARS);
  if (source.length < raw.length) {
    const firstEnd = nextEnd(source, 0);
    source = firstEnd < 0 ? '' : source.slice(firstEnd).trimStart();
  }
  const sentences = finishedSentences(source, 0, true)
    .sentences.map((sentence) => sentence.trim())
    .filter(Boolean);
  const latest = sentences.at(-1) ?? '';
  if (latest.length > max) return `${latest.slice(0, Math.max(0, max - 1))}…`;
  const previous = sentences.at(-2);
  const separator = previous && /[。！？]$/.test(previous) ? '' : ' ';
  return previous && previous.length + latest.length + separator.length <= max ? `${previous}${separator}${latest}` : latest;
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

const END = /[.!?]+["”’)\]*_`~]*(?=\s|$)|[。！？]+["”’)\]*_`~]*|\n+/g;
// Not an end: the last dot of single letters and dots (e.g., i.e.), or a numbered list item’s marker.
const NOT_END = /(?:^|[^\w.])(?:\w\.){2,}["”’)\]*_`~]*$|^\s*\d{1,9}[.)]$/;
/** Where the sentence that starts at rest[from] ends, or -1 when it hasn’t yet. @param {string} rest @param {number} from */
function nextEnd(rest, from) {
  // A fence opens a line, and its info string has no backtick: “```x``` is the tool.” is prose. One inside a list
  // item is indented, and so is its close.
  const fence = /^(\s*)(`{3,}|~{3,})[^`\n]*\n/.exec(rest.slice(from));
  if (fence && (from === 0 || rest[from - 1] === '\n' || fence[1].includes('\n'))) {
    const body = from + fence[0].length;
    // A line of the fence’s character, at least as long as its opening, closes it (#344).
    for (const close of rest.slice(body).matchAll(/^[ \t]*(`+|~+)[ \t]*$/gm)) if (close[1].startsWith(fence[2])) return body + close.index + close[0].length;
    return -1;
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
  const html = renderMarkdown(String(src).replace(/<\/?(details|summary)>/g, ' '))
    .replace(/<pre[\s\S]*?<\/pre>/g, ' ')
    // A sentence cut out of the middle of bold or code keeps a mark the renderer couldn’t pair; code keeps its own.
    .split(/(<code>[\s\S]*?<\/code>)/)
    .map((part, i) => (i % 2 ? part : part.replace(/\*\*|__|~~|`/g, '')))
    .join('')
    .replace(/<(br|hr|\/p|\/li|\/h\d|\/blockquote|\/div|\/t[dh])>/g, ' ');
  return stripTags(html)
    .replace(/&(amp|lt|gt|quot|#39);/g, (e) => ENTITIES[e])
    .replace(/\s+/g, ' ')
    .trim();
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
