// The code block’s parts below its header: the Copy button with the line that says whether it worked, and the
// code itself, one numbered line at a time. blocks.mjs builds the header and puts them in it.

import { h, icon, plural } from './dom.mjs';

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

/** A code block’s code, with a number on each line. */
export function codeBox(b) {
  const lines = b.code.split('\n');
  return h(
    'div.code',
    h(
      'pre.mono',
      { tabindex: '0', 'aria-label': `${b.filename ?? 'Code'}, ${plural(lines.length, 'line')}` },
      lines.map((l, i) => [h('span.ln', { 'aria-hidden': 'true' }, String(i + 1)), l, i < lines.length - 1 ? '\n' : '']),
    ),
  );
}
