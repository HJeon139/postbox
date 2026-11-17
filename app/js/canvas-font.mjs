// What the composer measures text in: a canvas, so laying out a line never reads the page’s layout (#1437, #442).

/**
 * An element’s font, for a canvas to measure in. Built from its parts: the computed `font` shorthand is empty where a
 * part it can’t say is set, and a canvas given nothing measures in its own 10 px font. @param {Element} el
 */
export function fontOf(el) {
  const cs = getComputedStyle(el);
  return `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
}
