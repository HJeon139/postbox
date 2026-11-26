// Text over marks, for the pre-display check (app/kit/check.js), #952: an SVG chart’s labels drawn over its dots, rings
// and lines, which hides the marks under them and the values they carry. It tests the marks’ own geometry under each
// label (isPointInFill, isPointInStroke), not their boxes, so a label beside a line whose box it shares passes. An
// axis, its ticks, a grid and a legend are left out, and so are a count inside its own dot, a label with a halo that
// keeps it legible, and one on a backing. Postbox inlines it into a check frame’s page after check-boxes.js.
// biome-ignore lint/suspicious/noRedundantUseStrict: the page runs this as a classic script, which isn’t strict without it.
'use strict';
{
  const { clip, where, hidden, guard } = window.__pbCheck;
  // Points under a label are tested on this grid, in px, inside an edge this wide: a label grazing a mark passes.
  const STEP = 1;
  const EDGE = 1;
  // A label sits on a mark when this many of its points hit it.
  const HITS = 2;
  // A filled path smaller than this is a symbol, a dot drawn as a path; a larger one is an area, which labels sit in.
  const SYMBOL = 30;
  // A dot or ring is a data mark up to this radius, in px; a larger circle is a diagram’s node, which holds its name.
  const DOT = 12;
  // A line is a data series from this many points on: a segment or a single curve is a diagram’s edge or a leader line.
  const SERIES = 3;
  // A line spans at least this many px: a shorter one is part of an icon.
  const SPAN = 40;
  // A mark paints at least this alpha, and a line is at most this wide in px: fainter, or wider, it’s a band or a halo
  // drawn behind the data, which labels sit over.
  const SOLID = 0.35;
  const WIDE = 8;
  const OUT = 'defs, clipPath, mask, marker, pattern, symbol';
  // A chart’s furniture, not its data: what d3 and most hand-drawn charts call their axes, ticks, grids and legends.
  const FURNITURE = /\b(axis|axes|tick|ticks|domain|grid|gridline|legend|key)\b/i;

  const furniture = (el, svg) => {
    for (let e = el; e && e !== svg; e = e.parentElement) {
      const name = `${e.getAttribute('class') ?? ''} ${e.id ?? ''}`;
      if (FURNITURE.test(name)) return true;
    }
    return false;
  };
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
  const solid = (paint, opacity) => alpha(paint) * opacity >= SOLID;
  const meets = (a, b, pad = 0) => a.left < b.right + pad && b.left < a.right + pad && a.top < b.bottom + pad && b.top < a.bottom + pad;
  const within = (a, b) => a.left >= b.left - 1 && a.right <= b.right + 1 && a.top >= b.top - 1 && a.bottom <= b.bottom + 1;

  /** An SVG’s data marks, with what of each paints: its fill (a dot) or its stroke (a ring, a line). */
  function marks(svg) {
    const out = [];
    for (const el of svg.querySelectorAll('circle, ellipse, path, polyline')) {
      if (el.closest(OUT) || hidden(el) || furniture(el, svg)) continue;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const round = el.tagName === 'circle' || el.tagName === 'ellipse';
      if (round && Math.max(r.width, r.height) > 2 * DOT) continue;
      if (!round && r.width > SYMBOL && points(el) < SERIES) continue;
      const symbol = round || (r.width <= SYMBOL && r.height <= SYMBOL);
      const fill = solid(cs.fill, +cs.fillOpacity * +cs.opacity) && symbol;
      const width = parseFloat(cs.strokeWidth) || 0;
      const long = round || Math.max(r.width, r.height) >= SPAN;
      const stroke = solid(cs.stroke, +cs.strokeOpacity * +cs.opacity) && width > 0 && width <= WIDE && long;
      if (!fill && !stroke) continue;
      const kind = fill ? 'a dot' : round ? 'a ring' : 'a line';
      out.push({ el, r, fill, stroke, kind, round, pad: width / 2 });
    }
    return out;
  }

  /** How many points a line passes through: a polyline’s, or a path’s command endpoints. */
  function points(el) {
    if (el.tagName === 'polyline') return el.points.numberOfItems;
    return (el.getAttribute('d') ?? '').match(/[MLHVCSQTAZ]/gi)?.filter((c) => !/z/i.test(c)).length ?? 0;
  }

  /** An SVG’s labels: its <text>, less a label with a halo and one on a backing. An axis’s labels count: on a data mark, they hide it too. */
  function labels(svg, backings) {
    const out = [];
    for (const el of svg.querySelectorAll('text')) {
      if (el.parentElement.closest('text') || el.closest(OUT) || hidden(el)) continue;
      const t = el.textContent.trim();
      const r = el.getBoundingClientRect();
      if (!t || r.width < 2 * EDGE + 1 || r.height < 2 * EDGE + 1) continue;
      const cs = getComputedStyle(el);
      if (painted(cs.stroke, +cs.strokeOpacity) && parseFloat(cs.strokeWidth) >= 2) continue;
      if (backings.some((b) => within(r, b))) continue;
      out.push({ el, t, r });
    }
    return out;
  }

  /** Opaque rectangles a label can sit on, under a third of the SVG: a backing, a bar, a box. */
  function backings(svg) {
    const whole = svg.getBoundingClientRect();
    return [...svg.querySelectorAll('rect')]
      .filter((el) => !el.closest(OUT) && !hidden(el) && painted(getComputedStyle(el).fill, +getComputedStyle(el).fillOpacity))
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.width * r.height <= (whole.width * whole.height) / 3);
  }

  /** How many of a label’s points fall on a mark’s painted fill or stroke. */
  function hits(label, mark) {
    const ctm = mark.el.getScreenCTM();
    if (!ctm) return 0;
    const inv = ctm.inverse();
    let n = 0;
    for (let y = label.r.top + EDGE; y <= label.r.bottom - EDGE; y += STEP)
      for (let x = label.r.left + EDGE; x <= label.r.right - EDGE; x += STEP) {
        const p = new DOMPoint(x, y).matrixTransform(inv);
        if ((mark.fill && mark.el.isPointInFill(p)) || (mark.stroke && mark.el.isPointInStroke(p))) n++;
        if (n >= HITS) return n;
      }
    return n;
  }

  /** text-over-marks, for each SVG that isn’t inside another one. */
  function textOverMarks() {
    hidden.reset();
    const out = [];
    for (const svg of document.querySelectorAll('svg')) {
      if (svg.parentElement.closest('svg') || hidden(svg)) continue;
      const all = marks(svg);
      const on = [];
      for (const l of labels(svg, backings(svg))) {
        // A label inside its own dot or ring, such as a count, is that mark’s label, not one drawn over it. A line’s box
        // holds labels that aren’t its own.
        const under = all.find((m) => meets(l.r, m.r, m.pad) && !(m.round && within(l.r, m.r)) && hits(l, m) >= HITS);
        if (under) on.push({ ...l, kind: under.kind });
      }
      if (!on.length) continue;
      const such = on.slice(0, 3).map((l) => `“${clip(l.t)}” (on ${l.kind})`);
      out.push({
        code: 'text-over-marks',
        message: `In ${where(svg)}, ${on.length} label${on.length === 1 ? '' : 's'} sit${on.length === 1 ? 's' : ''} on the chart’s marks, such as ${such.join(', ')}, hiding the marks and the values they carry. Place each label clear of the dots and lines: beside its mark, or in the margin with a short leader line.`,
      });
    }
    return out;
  }

  window.__pbCheck.textOverMarks = guard('text-over-marks', textOverMarks);
}
