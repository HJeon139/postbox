// The commands a confirm names (#852 slice 1a): what runs, with no second card, once the person confirms. The person
// must see every byte of each, so an entry may hold only text that draws as itself. Pure and dependency-free, so the
// catalog and the server share one check.

import { str } from './schema.mjs';

/** How many commands a confirm may name, and how long each may be. */
export const COMMANDS = Object.freeze({ max: 3, length: 2000, line: 400 });

// Each class of character that could hide or reorder what runs, with the reason a refusal gives. The first that
// matches names the character, so the narrow classes come before the wide ones that hold them (a tag character is
// also a format character, a variation selector also a combining mark).
/** @type {[RegExp, string][]} */
const HIDDEN = [
  [/[^\P{Cc}\t\n]/u, 'a control character (a command may hold tabs and new lines only)'],
  [/[\u{E0000}-\u{E007F}]/u, 'a tag character, which draws as nothing'],
  [/[\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/u, 'a variation selector, which draws as nothing'],
  [/\p{Cf}/u, 'an invisible formatting character, which can hide or reorder text'],
  [/[\p{Zl}\p{Zp}]/u, 'a line or paragraph separator, which breaks a line where a shell doesn’t'],
  [/\p{Mn}/u, 'a combining mark, which changes how the character before it looks'],
  [/[\u115F\u1160\u3164\uFFA0]/u, 'a Hangul filler, which draws as blank space'],
];

const codePoint = (ch) => `U+${/** @type {number} */ (ch.codePointAt(0)).toString(16).toUpperCase().padStart(4, '0')}`;

/**
 * Why a command can’t be shown on a confirm as written, or null when it can.
 * @param {string} text  one command
 * @returns {string | null}  a phrase that follows the entry’s name, such as “has U+202E, an invisible formatting character…”
 */
export function commandProblem(text) {
  for (const [pattern, reason] of HIDDEN) {
    const found = pattern.exec(text);
    if (found) return `has ${codePoint(found[0])}, ${reason}. Take it out.`;
  }
  if (/ {3}/.test(text)) return 'has three or more spaces in a row, which can push the rest out of view. Use one or two.';
  if (text.split('\n').some((line) => line.length > COMMANDS.line)) {
    return `has a line longer than ${COMMANDS.line} characters. Break it with a backslash and a new line.`;
  }
  return null;
}

/** The catalog’s rule for one command: text of 1 to 2,000 characters with no problem above. */
export const command = () => {
  const text = str({ min: 1, max: COMMANDS.length });
  return (v, path, errs) => {
    const before = errs.length;
    text(v, path, errs);
    if (errs.length > before) return;
    const problem = commandProblem(v);
    if (problem) errs.push(`${path} ${problem}`);
  };
};
