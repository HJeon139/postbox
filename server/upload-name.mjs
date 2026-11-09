// An uploaded file’s name (POST /api/files, its x-filename header), as its attachment chip and the agents it’s sent to
// show it (#991). The file is the person’s, and its name is only shown, so a character that would hide or reorder the
// name is replaced with “_”, as \ and / are, rather than the upload refused over it.

import { hasControl, hiddenInFolder } from '../shared/invisible.mjs';
import { partEnd } from '../shared/text-parts.mjs';

/** The longest name kept, in UTF-16 code units. */
const NAME_MAX = 200;

// VS16, the emoji presentation selector, and ZWJ: ❤️, 🏳️‍🌈 and 👨‍👩‍👧 are made with them, and ZWJ also shapes words in
// Indic scripts, such as a Devanagari half form or an older Malayalam chillu. A host path still refuses VS16.
const EMOJI_STYLE = '\ufe0f';
const JOINER = '\u200d';
// What each may follow (#1067): VS16 a character it shows as an emoji; ZWJ an emoji, a letter or a mark, VS16 and a
// virama among the marks. A character is at most two code units, so the two before it are enough to read.
const SHOWS_AS_EMOJI = /\p{Emoji}$/u;
const JOINS_AFTER = /(?:\p{Emoji}|\p{L}|\p{M})$/u;

// England’s, Scotland’s and Wales’s flags (#1067): 🏴, the tag letters gbeng, gbsct or gbwls, then CANCEL TAG, the only
// tag sequences that are emoji. Each is kept whole. Any other run of tag characters, after 🏴 or not, is hidden text,
// so each is replaced. The group keeps each flag in split()’s result, at odd places.
const TAG_FLAG = /(\u{1f3f4}\u{e0067}\u{e0062}(?:\u{e0065}\u{e006e}\u{e0067}|\u{e0073}\u{e0063}\u{e0074}|\u{e0077}\u{e006c}\u{e0073})\u{e007f})/u;

/**
 * Whether the character at `at` would hide or reorder a file’s name as it’s shown: a control character, a lone
 * surrogate, one a project’s folder refuses as hidden (shared/invisible.mjs), or a ZWJ, except a VS16 or a ZWJ where
 * it shows or joins what’s before it. ZWNJ, which joins letters, passes anywhere.
 * @param {string} text @param {string} c  the character @param {number} at  where it is in text
 */
function hides(text, c, at) {
  const before = text.slice(Math.max(0, at - 2), at);
  if (c === EMOJI_STYLE) return !SHOWS_AS_EMOJI.test(before);
  if (c === JOINER) return !JOINS_AFTER.test(before);
  return hasControl(c) || hiddenInFolder(c);
}

/**
 * Whether one character, read alone, would hide or reorder a name: a control character, a lone surrogate, or one a
 * project’s folder refuses as hidden, except VS16, since alone it can’t tell whether it shows an emoji (ZWNJ and ZWJ
 * pass hiddenInFolder). For a caller that checks a name one character at a time: a dataset’s title
 * (server/datasets.mjs) and the project picker’s marks (server/folders.mjs), from #1052.
 * @param {string} c  one code point, or a lone surrogate
 */
export const hidesName = (c) => c !== EMOJI_STYLE && (hasControl(c) || hiddenInFolder(c));

/** One part of a name, outside a flag, with each character that hides it as “_”. @param {string} part */
const shownPart = (part) => part.replace(/./gsu, (c, at) => (hides(part, c, at) ? '_' : c));

/**
 * A name as it shows: each character that would hide or reorder it is “_”, and each flag is kept whole. A message’s
 * project file is held to it too, and refused rather than changed (server/message-attachments.mjs).
 * @param {string} name
 */
export const shownName = (name) =>
  name
    .split(TAG_FLAG)
    .map((part, i) => (i % 2 ? part : shownPart(part)))
    .join('');

/**
 * The name to keep for an upload: cut at NAME_MAX, never between the halves of a surrogate pair, then each \, / and
 * character that hides it is “_”. It’s cut first, so a flag the cut ends inside isn’t kept as one. An empty name is
 * “file”.
 * @param {string} sent  the header, decoded
 * @returns {string}
 */
export function uploadName(sent) {
  const cut = sent.slice(0, partEnd(sent, NAME_MAX));
  return shownName(cut.replace(/[\\/]/g, '_')) || 'file';
}

/**
 * A stored upload’s name, as a message or the corpus shows it (#1067). One stored before #991 may hold a character that
 * hides it, and is shown cleaned as an upload’s is; the record keeps what was stored.
 * @param {string} name
 */
export const storedName = (name) => (shownName(name) === name ? name : uploadName(name));
