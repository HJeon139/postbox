// Whether an agent app’s page shows something real: a mark, a picture, a table, a control, or words that aren’t only an
// error or a missing-data message. Postbox adds it to every app page before the kit (server/sandbox.mjs). The kit asks
// it when the app hits a script error, to keep an app that drew running (#964), and the pre-display check asks it for
// an app that shows only an error (the only-error note in app/kit/check.js).
(function () {
  const ONLY_ERROR = /\b(?:error|failed|isn[’']t loaded|not loaded|restart postbox|no data|missing|couldn[’']t|could not|can[’']t load|unable to|not found)\b/i;
  const MARKS = 'svg circle, svg rect, svg ellipse, svg path, svg line, svg polyline, svg polygon, svg image';
  const shown = (el) => {
    const b = el.getBoundingClientRect();
    if (!b.width && !b.height) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && +cs.opacity !== 0;
  };
  // A canvas has drawn when it differs from a blank one of its size. A WebGL canvas that doesn’t keep its drawing
  // buffer reads as blank here.
  const painted = (c) => {
    if (!c.width || !c.height || !shown(c)) return false;
    const blank = document.createElement('canvas');
    blank.width = c.width;
    blank.height = c.height;
    return c.toDataURL() !== blank.toDataURL();
  };
  const mark = (el) => {
    if (el.closest('defs, clipPath, mask, marker, pattern, symbol') || !shown(el)) return false;
    if (el.tagName === 'image') return true;
    const cs = getComputedStyle(el);
    return cs.fill !== 'none' || (cs.stroke !== 'none' && parseFloat(cs.strokeWidth) > 0);
  };
  /** The page’s visible words, SVG labels too, in one line. */
  function said() {
    const words = [];
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const el = n.parentElement;
      if (n.textContent.trim() && el && !el.closest('script, style') && shown(el)) words.push(n.textContent);
    }
    return words.join(' ').trim().replace(/\s+/g, ' ');
  }
  /** What the page shows: { content } when it drew a mark, a picture, a table or a control, and its words. */
  function look() {
    if (!document.body) return { content: false, said: '' };
    const content =
      [...document.querySelectorAll(MARKS)].some(mark) ||
      [...document.querySelectorAll('canvas')].some(painted) ||
      [...document.querySelectorAll('img, table tr, input, select, textarea')].some(shown);
    return { content, said: said() };
  }
  /** Words that read as only an error or a missing-data message. */
  const onlyError = (words) => !!words && words.length < 300 && ONLY_ERROR.test(words);
  /** Whether the page shows something real, not nothing and not only an error. */
  function drawn() {
    const { content, said: words } = look();
    return content || (!!words && !onlyError(words));
  }
  window.__pbDrawn = { look, onlyError, drawn };
})();
