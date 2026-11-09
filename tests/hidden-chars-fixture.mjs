// The characters a name that reaches the page must not carry unmarked (#1052): control characters, ones that reorder
// text or show as nothing (shared/invisible.mjs), and a lone surrogate, which shows as nothing or as a box. Keyed by
// the name an assertion reports. FINE are names with none, which pass as they are.

export const HOSTILE = {
  NUL: '\u0000',
  'U+0085': '\u0085',
  'U+202E': '\u202E',
  'U+2066': '\u2066',
  'U+200B': '\u200B',
  'U+FEFF': '\uFEFF',
  'U+3164': '\u3164',
  'U+FE0F': '\uFE0F',
  'U+034F': '\u034F',
  'U+E0041': '\u{E0041}',
  'a lone surrogate': '\uD800',
};

export const FINE = ['é', '日本', 'a"b', 'a<b', 'a&b'];
