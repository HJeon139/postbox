// A Markdown image that can’t load says so in its place, as an image block does (#180, #218), wherever Markdown is
// drawn: in a message, a block or a review. Imported once, for this listener, by blocks.mjs.

import { h, icon } from './dom.mjs';

// An image’s error doesn’t bubble, so this listens as it’s captured.
addEventListener(
  'error',
  (e) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement) || !img.classList.contains('md-img')) return;
    img.replaceWith(h('span.err.img-failed', icon('warn'), img.alt ? `This image couldn’t load. It shows: ${img.alt}` : 'This image couldn’t load.'));
  },
  true,
);
