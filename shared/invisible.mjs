// Characters that change how text around them displays, or that display as nothing (#704, #817, #1049): every format
// character (Cf: zero-width ones, soft hyphens, word joiners, invisible operators, tag characters, U+FEFF), the bidi
// marks, embeddings, overrides and isolates, every default-ignorable code point (the Hangul fillers, the combining
// grapheme joiner, the variation selectors, VS17 to VS256 included, the Mongolian free variation selectors, the Khmer
// inherent vowels, the unassigned specials U+FFF0 to U+FFF8, and the tag block and the rest of U+E0000 to U+E0FFF,
// assigned or not), and the line and paragraph separators (Zl, Zp), which break a line where none shows. A
// right-to-left override can make a command, or a name, read as another one. ZWNJ, ZWJ and VS16 are among them: a
// caller that takes one takes it out itself (hiddenInFolder, and hides in server/upload-name.mjs).

/** Each such character, for replace(). It’s global, so test() would keep its place between calls: ask hasInvisible. */
export const INVISIBLE = /[\p{Cf}\p{Bidi_Control}\p{Default_Ignorable_Code_Point}\p{Zl}\p{Zp}]/gu;

/** Whether text holds one of INVISIBLE’s characters. search() starts at the beginning every time. @param {string} s */
export const hasInvisible = (s) => s.search(INVISIBLE) !== -1;

// A control character (C0, DEL or C1), NUL included: none belongs in a folder’s path.
const CONTROL = /\p{Cc}/u;
/** Whether text holds a control character. @param {string} s */
export const hasControl = (s) => CONTROL.test(s);

// A lone surrogate (Cs) isn’t text. The characters that change how a path displays, or display as nothing, are the
// ones an asset name refuses (INVISIBLE), except ZWNJ and ZWJ (U+200C, U+200D): they join letters in some scripts and
// in emoji, and the folder exists under the name the person gave it (#547). VS16 (U+FE0F) is refused, so a path with
// ❤️ or 🏳️‍🌈 is, ZWJ or not. A path on a host is checked so too. An upload’s name has each such character replaced,
// but keeps VS16 and ZWJ where they make an emoji or a word, and a tag flag whole, since it’s only shown
// (server/upload-name.mjs, #991, #1067).
const SURROGATE = /\p{Cs}/u;
const JOINERS = /[\u200c\u200d]/gu;
/** Whether a folder's path holds a character that isn't text, or one that hides or reorders what it shows. @param {string} s */
export const hiddenInFolder = (s) => SURROGATE.test(s) || hasInvisible(s.replace(JOINERS, ''));
