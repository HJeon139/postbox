// What the composer measures text in: a canvas, so laying out a line never reads the page’s layout (#1437, #442).

/**
 * An element’s font, for a canvas to measure in. Built from its parts: the computed `font` shorthand is empty where a
 * part it can’t say is set, and a canvas given nothing measures in its own 10 px font. @param {Element} el
 */
export function fontOf(el) {
  const cs = getComputedStyle(el);
  return `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
}

const ctx = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');

/**
 * A text’s width in a font. Its digits are measured as “0”: the page draws numbers with tabular figures
 * (font-variant-numeric in workbench.css), each as wide as a “0”, which a canvas can’t, so “11%” measured as written
 * came out nearly 4 px short. @param {string} text @param {string} font
 */
export function textWidth(text, font) {
  if (!ctx) return 0;
  ctx.font = font;
  return ctx.measureText(text.replace(/[0-9]/g, '0')).width;
}
