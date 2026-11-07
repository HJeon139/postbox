// An attachment on a sent message, and the size it shows, moved out of thread.mjs at its size ceiling.

import { INLINE_TYPES } from '/shared/files.mjs';
import { h, icon } from './dom.mjs';

export const fileSize = (size) => (size > 1e6 ? `${(size / 1e6).toFixed(1)} MB` : `${Math.ceil(size / 1000)} KB`);

/** The icon for a chip: a project file’s folder, an image, or a file. @param {any} a */
function chipIcon(a) {
  if (a.kind === 'project-file') return 'folder';
  return /^image\//.test(a.type ?? '') ? 'image' : 'file';
}

/**
 * An attachment on a sent message. Images the server shows inline (INLINE_TYPES) get a thumbnail that opens
 * the full image in a new tab; everything else, an SVG included, is a file chip that downloads.
 */
export function attChip(a) {
  const label = a.kind === 'project-file' ? a.path : a.name;
  const href = a.fileId ? `/api/files/${encodeURIComponent(a.fileId)}` : null;
  if (href && INLINE_TYPES.has(a.type)) {
    // One link: the image’s alt text and the size are its name, so it reads as “photo.png · 318 KB”.
    return h(
      'a.att-image',
      { href, target: '_blank', rel: 'noopener' },
      h('img', { src: href, alt: a.name, width: '160', height: '120', loading: 'lazy', decoding: 'async' }),
      h('span.att-cap', h('span.att-name', { 'aria-hidden': 'true' }, a.name), a.size ? h('span.dim', ` · ${fileSize(a.size)}`) : null),
    );
  }
  return h(
    'span.att',
    h('span.thumb', icon(chipIcon(a), 'i-sm')),
    href ? h('a', { href, style: { color: 'inherit' } }, label) : label,
    a.size ? h('span.dim', ` · ${fileSize(a.size)}`) : null,
  );
}
