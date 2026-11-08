// Text in boxes, for the pre-display check (app/kit/check.js), #997: a figure drawn as boxes holding their names (the
// critique’s VE10), and a box holding a sentence (VE3). It measures SVG, where agents draw figures, Mermaid’s included;
// a page’s panels of prose beside its figure are left to the critique. Postbox inlines it into a check frame’s page
// after check-text.js.
// biome-ignore lint/suspicious/noRedundantUseStrict: the page runs this as a classic script, which isn’t strict without it.
'use strict';
{
  const { clip, where, hidden, guard } = window.__pbCheck;
  // A box holding more words than this holds a sentence, not a label: the critique’s “more than about six words”. A
  // sentence in SVG is set as up to a few lines of text; a box holding more labels than that is a region or a group.
  const MAX_WORDS = 6;
  const MAX_LINES = 3;
  // A figure is drawn as labeled boxes when this share of its labels sit in boxes, and at least this many do. Measured
  // on the first versions of 175 apps from past UAT runs, 139 of them with SVG labels: the 7 these hold back are all
  // diagrams of named boxes (a bill’s path, a save’s steps, a module map, a signaling network).
  const SHARE = 0.3;
  const MIN_BOXED = 5;

  const words = (t) => t.match(/\p{L}[\p{L}\p{N}'’-]*/gu) ?? [];
  // A name, not a number, a unit or a day’s initials: it has a word of three letters or more.
  const names = (t) => words(t).some((w) => w.length >= 3);
  const area = (r) => r.width * r.height;
  const within = (a, b) => a.left >= b.left - 2 && a.right <= b.right + 2 && a.top >= b.top - 2 && a.bottom <= b.bottom + 2;
  // A paint’s alpha: none paints nothing, and a gradient or pattern counts as opaque.
  const alpha = (paint) => {
    const m = paint.match(/rgba?\(([^)]+)\)/);
    if (m)
      return (
        m[1]
          .split(/[ ,/]+/)
          .filter(Boolean)
          .map(Number)[3] ?? 1
      );
    return paint === 'none' ? 0 : 1;
  };
  const painted = (paint, opacity) => alpha(paint) * opacity > 0.05;

  // An SVG’s boxes: rectangles, and four-cornered polygons (a flowchart’s diamonds), filled or outlined; a triangle or
  // another polygon is a region of a map. One over a third of the SVG is a background or a plot area, and one that
  // holds another box is a group’s frame.
  function boxes(svg) {
    const whole = area(svg.getBoundingClientRect());
    const all = [];
    for (const el of svg.querySelectorAll('rect, polygon')) {
      if (el.closest('defs, clipPath, mask, marker, pattern, symbol') || hidden(el) || (el.points && el.points.numberOfItems !== 4)) continue;
      const cs = getComputedStyle(el);
      if (!painted(cs.fill, +cs.fillOpacity) && !(painted(cs.stroke, +cs.strokeOpacity) && parseFloat(cs.strokeWidth) > 0)) continue;
      const r = el.getBoundingClientRect();
      if (area(r) >= 1 && area(r) <= whole / 3) all.push({ el, r });
    }
    return all.filter((a) => !all.some((b) => b !== a && area(b.r) < area(a.r) && within(b.r, a.r)));
  }

  // An SVG’s labels that name something: its <text> elements, and the HTML Mermaid puts in a foreignObject.
  function labels(svg) {
    const out = [];
    const add = (el, t) => {
      if (!hidden(el) && names(t)) out.push({ el, t, r: el.getBoundingClientRect() });
    };
    for (const el of svg.querySelectorAll('text')) if (!el.parentElement.closest('text')) add(el, el.textContent.trim());
    for (const el of svg.querySelectorAll('foreignObject *'))
      if (![...el.children].length || [...el.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim())) add(el, el.textContent.trim());
    return out.filter((l) => l.r.width && l.r.height);
  }

  /** text-in-boxes and words-in-box, for each SVG that isn’t inside another one. */
  function textInBoxes() {
    hidden.reset();
    const out = [];
    for (const svg of document.querySelectorAll('svg')) {
      if (svg.parentElement.closest('svg') || hidden(svg)) continue;
      const shapes = boxes(svg);
      const held = new Map();
      const all = labels(svg);
      for (const l of all) {
        const box = shapes.filter((s) => within(l.r, s.r)).sort((a, b) => area(a.r) - area(b.r))[0];
        if (box) held.set(box.el, [...(held.get(box.el) ?? []), l]);
      }
      const boxed = [...held.values()].flat();
      if (boxed.length >= MIN_BOXED && boxed.length / all.length >= SHARE) {
        const such = boxed.slice(0, 3).map((l) => `“${clip(l.t)}” (${where(l.el)})`);
        out.push({
          code: 'text-in-boxes',
          message: `In ${where(svg)}, ${boxed.length} of ${all.length} labels sit inside boxes, such as ${such.join(', ')}: a figure of boxes holding their names. Draw each part as what it is or does (a small drawing, an icon, a mark that carries its value), with its label beside it.`,
        });
      }
      for (const [el, held1] of held) {
        const text = held1.map((l) => l.t).join(' ');
        const n = words(text).length;
        if (n > MAX_WORDS && held1.length <= MAX_LINES && out.filter((p) => p.code === 'words-in-box').length < 3)
          out.push({
            code: 'words-in-box',
            message: `${where(el)} holds ${n} words, “${clip(text)}”: a sentence in a box. Name the part in three words or fewer, and say the rest in the line under the figure.`,
          });
      }
    }
    return out;
  }

  window.__pbCheck.textInBoxes = guard('text-in-boxes', textInBoxes);
}
