// Text in boxes, for the pre-display check (app/kit/check.js), #997: a figure drawn as boxes holding their names (the
// critique’s VE10), and a box holding a sentence (VE3). It measures SVG, where agents draw figures, Mermaid’s included;
// a page’s panels of prose beside its figure are left to the critique. Postbox inlines it into a check frame’s page
// after check-text.js.
// biome-ignore lint/suspicious/noRedundantUseStrict: the page runs this as a classic script, which isn’t strict without it.
'use strict';
{
  const { rgb, clip, where, hidden, guard } = window.__pbCheck;
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

  // The background behind an SVG: its own, or the nearest opaque one of the page around it.
  function backdrop(svg) {
    for (let e = svg; e; e = e.parentElement) {
      const c = rgb(getComputedStyle(e).backgroundColor);
      if (c && c.a > 0.95) return c;
    }
    return rgb(getComputedStyle(document.documentElement).backgroundColor);
  }
  const same = (a, b) => !!a && !!b && Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b) < 12;

  // An SVG’s boxes: rectangles, and four-cornered polygons (a flowchart’s diamonds), filled or outlined; a triangle or
  // another polygon is a region of a map, and circles and shapes drawn by <use> aren’t measured: in past apps, labels in
  // circles were counts on dots. A rect filled with the SVG’s background and no outline is a backing that keeps a label
  // legible, not a box. One over a third of the SVG is a background or a plot area. One that holds another mark is a
  // frame (a legend of swatches or line keys, a group of boxes); a strip under 8 px (an accent down a box’s edge)
  // doesn’t make its box a frame.
  function boxes(svg) {
    const whole = area(svg.getBoundingClientRect());
    const bg = backdrop(svg);
    const all = [];
    for (const el of svg.querySelectorAll('rect, polygon')) {
      if (el.closest('defs, clipPath, mask, marker, pattern, symbol') || hidden(el) || (el.points && el.points.numberOfItems !== 4)) continue;
      const cs = getComputedStyle(el);
      const outlined = painted(cs.stroke, +cs.strokeOpacity) && parseFloat(cs.strokeWidth) > 0;
      if (!painted(cs.fill, +cs.fillOpacity) && !outlined) continue;
      if (!outlined && same(rgb(cs.fill), bg)) continue;
      const r = el.getBoundingClientRect();
      if (area(r) >= 1 && area(r) <= whole / 3) all.push({ el, r });
    }
    const marks = [...svg.querySelectorAll('line, path, polyline, circle, ellipse, use, image')]
      .filter((m) => !m.closest('defs, clipPath, mask, marker, pattern, symbol') && !hidden(m))
      .map((m) => m.getBoundingClientRect());
    // A mark’s box leaves out its stroke, so a legend’s line key is a box of no height: any size counts.
    const holdsMark = (a) => marks.some((r) => r.width + r.height > 0 && within(r, a.r));
    const holdsBox = (a) => all.some((b) => area(b.r) < area(a.r) && within(b.r, a.r) && Math.min(b.r.width, b.r.height) >= 8);
    return all.filter((a) => !holdsBox(a) && !holdsMark(a));
  }

  // Boxes holding labels that are a chart’s marks, which carry its values (the critique’s VE10 asks for these): bars or
  // a Gantt chart’s spans, three or more of one thickness whose lengths vary at least 1.5 times over, with more room around
  // some labels than others; and a treemap’s tiles, three or more whose sizes vary at least threefold, filling nine
  // tenths of the area they span. A diagram’s boxes are sized to their names, with the same room around each, or all one size,
  // with gaps between them for its arrows.
  function marksOfData(shapes, held) {
    const data = new Set();
    const room = (s, along) => s.r[along] - Math.max(0, ...(held.get(s.el) ?? []).map((l) => l.r[along]));
    for (const [along, across] of [
      ['width', 'height'],
      ['height', 'width'],
    ]) {
      const rows = new Map();
      for (const s of shapes.filter((x) => held.has(x.el))) rows.set(Math.round(s.r[across]), [...(rows.get(Math.round(s.r[across])) ?? []), s]);
      for (const set of rows.values()) {
        const lengths = set.map((s) => s.r[along]);
        const rooms = set.map((s) => room(s, along));
        if (set.length >= 3 && Math.max(...lengths) >= 1.5 * Math.min(...lengths) && Math.max(...rooms) - Math.min(...rooms) >= 30)
          for (const s of set) data.add(s.el);
      }
    }
    const tiles = shapes.filter((s) => held.has(s.el));
    const span = tiles.reduce(
      (b, s) => ({ l: Math.min(b.l, s.r.left), t: Math.min(b.t, s.r.top), r: Math.max(b.r, s.r.right), b: Math.max(b.b, s.r.bottom) }),
      { l: Infinity, t: Infinity, r: -Infinity, b: -Infinity },
    );
    const sizes = tiles.map((s) => area(s.r));
    const filled = sizes.reduce((a, b) => a + b, 0) / ((span.r - span.l) * (span.b - span.t));
    if (tiles.length >= 3 && Math.max(...sizes) >= 3 * Math.min(...sizes) && filled >= 0.9) for (const s of tiles) data.add(s.el);
    return data;
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
      for (const el of marksOfData(shapes, held)) held.delete(el);
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
