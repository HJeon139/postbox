// The code block’s parts below its header: the Copy button with the line that says whether it worked, the file’s
// name, and the code itself, highlighted, one numbered line at a time. blocks.mjs builds the header and puts them in it.

import { highlight } from '/shared/highlight.mjs';
import { h, icon, plural } from './dom.mjs';

// The design’s syntax classes (app/workbench.css, “Syntax highlighting”), by token kind.
const SYNTAX = { kw: 'kw', str: 'str', num: 'num-t', fn: 'fn', com: 'com' };

/** The Copy button for a code block, and the status line beside it. */
export function copyControls(b) {
  const status = h('span.small.dim', { role: 'status' });
  return [
    h(
      'button.btn.sm',
      {
        type: 'button',
        onclick: async () => {
          try {
            await navigator.clipboard.writeText(b.code);
            status.textContent = 'Copied';
          } catch {
            status.textContent = 'Couldn’t copy. Select the text instead.';
          }
          setTimeout(() => {
            status.textContent = '';
          }, 2000);
        },
      },
      icon('copy', 'i-sm'),
      'Copy',
    ),
    status,
  ];
}

/**
 * Shows the file’s name in a code block’s header (#41): as its title when it has none, or beside it. The title is
 * the block’s accessible name, so the name is read out too.
 */
export function showFilename(hd, b) {
  const title = hd.querySelector('.title');
  if (!b.filename || !title) return;
  const file = h('span.code-file.mono', b.filename);
  if (b.title && b.title !== b.filename) title.append(' ', h('span.dim', file));
  else title.replaceChildren(file);
}

/** A code block’s code, highlighted, with a number on each line. A comment or string over several lines is split. */
export function codeBox(b) {
  /** @type {(string | Node)[][]} */
  const lines = [[]];
  for (const t of highlight(b.code, b.language))
    t.text.split('\n').forEach((part, i) => {
      if (i) lines.push([]);
      if (part) lines.at(-1).push(t.kind ? h('span', { class: SYNTAX[t.kind] }, part) : part);
    });
  return h(
    'div.code',
    h(
      'pre.mono',
      { tabindex: '0', 'aria-label': `${b.filename ?? 'Code'}, ${plural(lines.length, 'line')}` },
      lines.map((l, i) => [h('span.ln', { 'aria-hidden': 'true' }, String(i + 1)), l, i < lines.length - 1 ? '\n' : '']),
    ),
  );
}
