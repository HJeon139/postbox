// Characters that change how text around them displays, or that display as nothing (#704, #817): every format
// character (Cf: zero-width ones, soft hyphens, word joiners, invisible operators, tag characters, U+FEFF), the bidi
// marks, embeddings, overrides and isolates, the Hangul fillers (U+115F, U+1160, U+3164, U+FFA0), the combining
// grapheme joiner (U+034F) and the variation selectors (U+FE00 to U+FE0F), which are marks rather than format
// characters, and the whole tag block (U+E0000 to U+E007F), whose unassigned code points aren’t Cf. A right-to-left
// override can make a command, or a name, read as another one.

/**
 * Each such character, for replace(). It’s global, so test() would keep its place between calls: ask hasInvisible.
 * The two marks are alternatives of their own: in one class with other characters, Biome reads them as combining.
 */
export const INVISIBLE = /[\p{Cf}\p{Bidi_Control}\u115f\u1160\u3164\uffa0\u{e0000}-\u{e007f}]|\u034f|[\ufe00-\ufe0f]/gu;

/** Whether text holds one of INVISIBLE’s characters. search() starts at the beginning every time. @param {string} s */
export const hasInvisible = (s) => s.search(INVISIBLE) !== -1;

// A control character (C0, DEL or C1), NUL included: none belongs in a folder’s path.
const CONTROL = /\p{Cc}/u;
/** Whether text holds a control character. @param {string} s */
export const hasControl = (s) => CONTROL.test(s);

// A lone surrogate (Cs) isn’t text. The characters that change how a path displays, or display as nothing, are the
// ones an asset name refuses (INVISIBLE), except ZWNJ and ZWJ (U+200C, U+200D): they join letters in some scripts and
// in emoji, and the folder exists under the name the person gave it (#547). A path on a host is checked so too, and an
// upload’s name has each such character replaced (#991).
const SURROGATE = /\p{Cs}/u;
const JOINERS = /[\u200c\u200d]/gu;
/** Whether a folder's path holds a character that isn't text, or one that hides or reorders what it shows. @param {string} s */
export const hiddenInFolder = (s) => SURROGATE.test(s) || hasInvisible(s.replace(JOINERS, ''));
