// Characters that change how text around them displays, or that display as nothing: every format character (Cf:
// zero-width ones, soft hyphens, word joiners, invisible operators, tag characters, U+FEFF), the bidi marks,
// embeddings, overrides and isolates, the Hangul fillers (U+115F, U+1160, U+3164, U+FFA0), the combining grapheme
// joiner (U+034F) and the variation selectors (U+FE00 to U+FE0F), which are marks rather than format characters, and the
// whole tag block (U+E0000 to U+E007F), whose unassigned code points aren’t Cf. A right-to-left override can make a
// command read as another one.
// The two marks are alternatives of their own: in one class with other characters, Biome reads them as combining.
export const INVISIBLE = /[\p{Cf}\p{Bidi_Control}\u115f\u1160\u3164\uffa0\u{e0000}-\u{e007f}]|\u034f|[\ufe00-\ufe0f]/gu;
