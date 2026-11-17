// A streaming reply's Markdown, split where nothing after can change what comes before (#850), so the page renders
// the blocks a reply has closed once, and each frame only what follows (app/js/md-stream.mjs).

import { blocks, renderMarkdown } from './markdown.mjs';
import { glossaryRegex, mentionRegex } from './markdown-inline.mjs';
import { LATEX_OPEN } from './math.mjs';

/**
 * A line read as text that a later line could turn into a fold or display math, once its close arrives: a `<details>`,
 * or a `\[` alone on its line, which opens a block only once its `\]` follows. A lone `$$` opens a block to the end
 * at once, so it never reads as text, and a line that only starts with `$$` or `\[` never opens a block.
 * @param {string} line
 */
const waitsForClose = (line) => line.trimStart().startsWith('<details>') || LATEX_OPEN.test(line);

/**
 * renderMarkdown, split at a cut: the start of a whole line after a blank one at the top level, where every block
 * before has ended, and nothing before waits for a close (a `<details>` or display math read as text so far, which
 * its close would turn into a fold or a formula). A list before such a blank line has ended: one that the next line
 * goes on takes the blank line in, so it never reaches the top level. head + tail is what renderMarkdown(src, opts)
 * gives, and head is what it gives for src's first `cut` characters. With positions, or a carriage return or NUL,
 * which renderMarkdown rewrites, there's no cut.
 * @param {string} src @param {Parameters<typeof renderMarkdown>[1]} [opts]
 * @returns {{ head: string, tail: string, cut: number }}
 */
export function renderMarkdownCut(src, opts = {}) {
  const text = String(src ?? '');
  if (opts.positions || /[\r\0]/.test(text)) return { head: '', tail: renderMarkdown(text, opts), cut: 0 };
  const lines = text.split('\n');
  let line = 0;
  let at = 0;
  let waiting = false;
  /** @type {string[] | null} */
  let out = null;
  const cut = {
    /** @param {number} i @param {string[]} blocksSoFar */
    blank(i, blocksSoFar) {
      out = blocksSoFar;
      // The line after is whole only if another follows it: the last line may still be growing.
      if (waiting || i + 2 >= lines.length) return;
      line = i + 1;
      at = blocksSoFar.length;
    },
    /** @param {string} l */
    text(l) {
      if (waitsForClose(l)) waiting = true;
    },
  };
  const html = blocks(lines, { ...opts, src: null, glossaryRe: glossaryRegex(opts.glossary), mentionRe: mentionRegex(opts.mentions) }, 0, cut);
  if (!out) return { head: '', tail: html, cut: 0 };
  let chars = 0;
  for (let k = 0; k < line; k++) chars += lines[k].length + 1;
  const all = /** @type {string[]} */ (out);
  return { head: all.slice(0, at).join(''), tail: all.slice(at).join(''), cut: chars };
}
