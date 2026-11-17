// Whether a placeholder fits on its composer’s one line (#1437). The full help shows where the box has room for it,
// and only whom it replies to where it hasn’t: a phone, or a conversation beside an open thread panel. The width comes
// from a ResizeObserver, so typing never reads the layout (composer-size.mjs says why that matters).

import { fontOf } from './canvas-font.mjs';

const ctx = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
/** Each box’s last room and font, by its id: a composer mounted again, as going back to a room does, starts measured, so
 * its first observation changes nothing and costs no layout (#1155). @type {Map<string, { room: number, font: string }>} */
const known = new Map();

/**
 * Watches a text box’s width. Until its first measure, nothing fits, so a cut-off placeholder never shows.
 * @param {HTMLTextAreaElement} ta @param {() => void} onChange called when the room changes
 * @returns {{ fits: (text: string) => boolean, stop: () => void }}
 */
export function placeholderRoom(ta, onChange) {
  let { room, font } = known.get(ta.id) ?? { room: 0, font: '' };
  const observer = new ResizeObserver(([entry]) => {
    const width = entry.contentRect.width;
    if (width === room) return;
    room = width;
    font = fontOf(ta);
    known.set(ta.id, { room, font });
    onChange();
  });
  observer.observe(ta);
  return {
    fits(text) {
      if (!ctx || !room) return false;
      ctx.font = font;
      return ctx.measureText(text).width <= room;
    },
    stop: () => observer.disconnect(),
  };
}
