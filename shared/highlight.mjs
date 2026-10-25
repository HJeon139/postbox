// Syntax highlighting for the code block (#41), with no dependency: one regular expression per family of languages
// finds comments, strings, numbers, keywords and the names of called functions. A language it doesn’t know stays
// plain text. It returns tokens, not markup: the browser builds the spans from them as text (app/js/code-block.mjs).

/** @typedef {'kw' | 'str' | 'num' | 'fn' | 'com'} TokenKind */
/** @typedef {{ kind: TokenKind | null, text: string }} Token */

const C_COMMENT = String.raw`\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)`;
const PY_COMMENT = String.raw`#[^\n]*`;
// # starts a comment only at the start of a line or after a space, so `$#` and `${#name}` in a shell script don’t.
const SH_COMMENT = String.raw`(?<!\S)#[^\n]*`;
const SQL_COMMENT = String.raw`--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)`;
// A string that isn’t closed runs to the end of its line, or of the code for one that may span lines, as an unclosed
// comment does. A pattern that failed instead was tried again at every later quote: 15 s on a 200,000-character line.
// An escape is a backslash and any character but a newline, \r included: with `.`, a backslash before a CR failed
// the string and backtracked through it (46 s on 200,000 characters).
const DQ = String.raw`"(?:[^"\\\n]|\\[^\n])*(?:"|\\?(?![^\n]))`;
const SQ = String.raw`'(?:[^'\\\n]|\\[^\n])*(?:'|\\?(?![^\n]))`;
const BQ = String.raw`\`(?:[^\`\\]|\\[\s\S])*(?:\`|\\?$)`;
const TRIPLE = String.raw`"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)`;
// A character literal ('x', '\n', '\u{1F600}'), but not a Rust lifetime ('a), which never closes.
const CHAR = String.raw`'(?:[^'\\\n]|\\[^\n]{1,10}?)'`;
const NUM = String.raw`\b(?:0[xX][\da-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)\b`;
const WORD = String.raw`[A-Za-z_$][\w$]*`;
const CALL = /\s*\(/y;

/** @param {{ comment: string, strings: string[], keywords: string, caseless?: boolean }} f */
const family = ({ comment, strings, keywords, caseless = false }) => ({
  // lint-allow regex: each language family's patterns are constants in this file.
  re: new RegExp(`(${comment})|(${strings.join('|')})|(${NUM})|(${WORD})`, 'g'),
  keywords: new Set(keywords.split(' ')),
  caseless,
});

const FAMILIES = {
  js: family({
    comment: C_COMMENT,
    strings: [BQ, DQ, SQ],
    keywords:
      'as async await break case catch class const continue debugger default delete do else enum export extends false finally for from function if implements import in instanceof interface let new null of private protected public readonly return static super switch this throw true try typeof undefined var void while yield',
  }),
  json: family({ comment: C_COMMENT, strings: [DQ], keywords: 'true false null' }),
  python: family({
    comment: PY_COMMENT,
    strings: [TRIPLE, DQ, SQ],
    keywords:
      'False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return self try while with yield',
  }),
  shell: family({
    comment: SH_COMMENT,
    strings: [DQ, SQ],
    keywords: 'case do done elif else esac export fi for function if in local return then until while',
  }),
  sql: family({
    comment: SQL_COMMENT,
    strings: [SQ, DQ],
    keywords:
      'all alter and as asc between by case create delete desc distinct drop else end exists false from group having in index inner insert into is join key left like limit not null on or order outer primary references right select set table then true union unique update values view when where with',
    caseless: true,
  }),
  // C, C++, C#, Java, Go, Rust, Kotlin and Swift share one list, so a keyword of one (Kotlin’s val, Rust’s match) is
  // colored in the others too. Go’s raw strings are in backquotes.
  c: family({
    comment: C_COMMENT,
    strings: [BQ, DQ, CHAR],
    keywords:
      'bool break case catch char class const continue default defer do double else enum extends false final float fn for fun func go if impl implements import int interface let long match mut namespace new nil null package private protected public return self static struct super switch this throw trait true try use val var void while',
  }),
};

/** Language names an agent may give (the catalog’s `language`, compared lowercased), by family. */
const LANGUAGES = {
  js: 'js',
  javascript: 'js',
  jsx: 'js',
  mjs: 'js',
  ts: 'js',
  typescript: 'js',
  tsx: 'js',
  json: 'json',
  jsonc: 'json',
  py: 'python',
  python: 'python',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  shell: 'shell',
  sql: 'sql',
  c: 'c',
  cpp: 'c',
  'c++': 'c',
  cs: 'c',
  csharp: 'c',
  'c#': 'c',
  java: 'c',
  go: 'c',
  rust: 'c',
  rs: 'c',
  kotlin: 'c',
  kt: 'c',
  swift: 'c',
};

/**
 * Splits code into tokens to highlight. Plain text has kind null, and the tokens’ text joins back to the code. A
 * comment or string that spans lines is one token.
 * @param {string} code
 * @param {string} [language]
 * @returns {Token[]}
 */
export function highlight(code, language = '') {
  const name = language.toLowerCase();
  if (!Object.hasOwn(LANGUAGES, name)) return [{ kind: null, text: code }];
  const f = FAMILIES[LANGUAGES[name]];
  /** @type {Token[]} */
  const out = [];
  /** @param {TokenKind | null} kind @param {string} text */
  const push = (kind, text) => {
    const last = out.at(-1);
    if (!text) return;
    if (!kind && last && !last.kind) last.text += text;
    else out.push({ kind, text });
  };
  let at = 0;
  for (const m of code.matchAll(f.re)) {
    const end = m.index + m[0].length;
    push(null, code.slice(at, m.index));
    push(kindOf(m, f, code, end), m[0]);
    at = end;
  }
  push(null, code.slice(at));
  return out;
}

/** @returns {TokenKind | null} */
function kindOf(m, f, code, end) {
  if (m[1] !== undefined) return 'com';
  if (m[2] !== undefined) return 'str';
  if (m[3] !== undefined) return 'num';
  // After a dot, a word is a property (b.type, map.delete), never a keyword.
  if (code[m.index - 1] !== '.' && f.keywords.has(f.caseless ? m[0].toLowerCase() : m[0])) return 'kw';
  CALL.lastIndex = end;
  return CALL.test(code) ? 'fn' : null;
}
