// A file’s diff in Work’s full form (app/js/work.mjs): the rows the server sent, with what stands in for a diff when
// there’s none to show (still loading, too large, binary, no difference).

import { formatBytes } from '/shared/work.mjs';
import { h, plural } from './dom.mjs';

/** @param {any} d  what the diff request returned @param {any} f  the file */
export function diffView(d, f) {
  if (!d) return h('p.small.dim', 'Loading the diff…');
  if (d.error) return h('p.small.dim', `The diff didn’t load: ${d.error}`);
  if (d.tooLarge)
    return h('p.small.dim', `Too large to show: ${formatBytes(d.before.size ?? 0)} → ${formatBytes(d.after.size ?? 0)}. Postbox keeps files up to 4 MB.`);
  if (d.binary)
    return h(
      'p.small.dim',
      `A binary file: ${d.before.exists ? formatBytes(d.before.size) : 'new'} → ${d.after.exists ? formatBytes(d.after.size) : 'deleted'}.`,
    );
  if (!d.rows.length) return h('p.small.dim', 'No difference.');
  return h(
    'div.work-diff-wrap',
    { tabindex: '0', role: 'region', 'aria-label': `Diff of ${f.rel}` },
    h(
      'div.rv-doc.work-diff',
      d.rows.map((r) =>
        r.kind === 'gap'
          ? h('div.work-gap', `⋯ ${plural(r.skipped, 'unchanged line')}`)
          : h(
              `div.rv-line.${r.kind}`,
              h('span.g-ln', { 'aria-label': r.kind === 'add' ? 'added' : r.kind === 'del' ? 'deleted' : null }, String(r.kind === 'del' ? r.o : r.n)),
              h('span.tx', r.t || ' '),
            ),
      ),
    ),
    d.cut ? h('p.small.dim', 'The rest of the diff is too long to show here.') : null,
  );
}
