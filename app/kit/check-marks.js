// Text over marks, for the pre-display check (app/kit/check.js), #952: an SVG chart’s labels drawn over its dots, rings
// and lines, which hides the marks under them and the values they carry. It tests the marks’ own geometry under each
// label (isPointInFill, isPointInStroke), not their boxes, so a label beside a line whose box it shares passes, and
// only the band of its letters, so a mark grazing the space above or below them passes too. An axis, its ticks, a grid
// and a legend are left out, and so are a count inside its own dot, a name inside its own node, a label with a halo
// that keeps it legible, and one on a backing. Postbox inlines it into a check frame’s page after check-boxes.js.
// biome-ignore lint/suspicious/noRedundantUseStrict: the page runs this as a classic script, which isn’t strict without it.
'use strict';
{
  const { clip, where, hidden, guard } = window.__pbCheck;
  // Points under a label are tested on this grid, in px, inside an edge this wide at its sides: a label grazing a mark
  // there passes.
  const STEP = 1;
  const EDGE = 1;
  // A label sits on a mark when this many of its points hit it. Above and below, the edge is this share of its font
  // size: that band of a line’s box holds only the tops of capitals, the descenders and line spacing, so a mark there
  // grazes the label without hiding it, or being hidden. Of a label of several lines, it trims the first line’s top and
  // the last one’s bottom.
  const HITS = 2;
  const CORE = 0.3;
  // A filled path smaller than this is a symbol, a dot drawn as a path; a larger one is an area, which labels sit in.
  const SYMBOL = 30;
  // A dot or ring is a data mark up to this radius, in px; a larger circle is a diagram’s node, which holds its name.
  const DOT = 12;
  // A closed outline up to this size in px, of up to this many commands, is a node, such as a box, a rounded box or a
  // hexagon, and a label inside it is its name. A larger one is a region, and one of more commands is an area chart, a
  // command for each data point: a label inside either can still sit on its edge.
  const NODE = 160;
  const SIDES = 12;
  // A line is a data series from this many points on. A straight line of two points is a fit line or a reference in a
  // chart (three or more dots or rings), and a diagram’s edge or a leader line anywhere else; one that’s level or upright, a
  // gridline, is never a mark.
  const SERIES = 3;
  const CHART = 3;
  // A line spans at least this many px: a shorter one is part of an icon.
  const SPAN = 40;
  // A mark paints at least this alpha, and a line is at most this wide in px: fainter, or wider, it’s a band or a halo
  // drawn behind the data, which labels sit over.
  const SOLID = 0.35;
  const WIDE = 8;
  // The check stops looking after this many ms, so a chart of thousands of marks can’t use up the frame’s time.
  const BUDGET = 2000;
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
  // A paint’s alpha, in any color syntax: rgba(…, a), or “/ a” in rgb(), oklch() and the rest.
  const alpha = (paint) => {
    if (paint === 'none') return 0;
    const slash = paint.match(/\/\s*([\d.]+)(%?)\s*\)$/);
    if (slash) return slash[2] ? +slash[1] / 100 : +slash[1];
    const m = paint.match(/rgba\(([^)]+)\)/);
    return m ? (m[1].split(/[ ,]+/).filter(Boolean).map(Number)[3] ?? 1) : 1;
  };
  /** An element’s opacity with its groups’, up to its SVG: a dot in a faint group is faint. */
  const opacityOf = (el, svg) => {
    let o = 1;
    for (let e = el; e && e !== svg; e = e.parentElement) o *= +getComputedStyle(e).opacity;
    return o;
  };
  const painted = (paint, opacity) => alpha(paint) * opacity > 0.05;
  const solid = (paint, opacity) => alpha(paint) * opacity >= SOLID;
  const meets = (a, b, pad = 0) => a.left < b.right + pad && b.left < a.right + pad && a.top < b.bottom + pad && b.top < a.bottom + pad;
  const within = (a, b) => a.left >= b.left - 1 && a.right <= b.right + 1 && a.top >= b.top - 1 && a.bottom <= b.bottom + 1;

  /**
   * An SVG’s data marks, with what of each paints: its fill (a dot) or its stroke (a ring, a line). A straight two-point
   * line counts only in a chart, as its fit line.
   */
  function marks(svg) {
    const found = [];
    for (const el of svg.querySelectorAll('circle, ellipse, path, polyline, line')) {
      if (el.closest(OUT) || hidden(el) || furniture(el, svg)) continue;
      const m = markOf(el, svg);
      if (m) found.push(m);
    }
    const chart = found.filter((m) => m.round || m.kind === 'a dot').length >= CHART;
    return found.filter((m) => !m.straight || chart);
  }

  /** One element as a data mark, or null. @param {Element} el @param {Element} svg */
  function markOf(el, svg) {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const round = el.tagName === 'circle' || el.tagName === 'ellipse';
    if (round && Math.max(r.width, r.height) > 2 * DOT) return null;
    const symbol = round || (r.width <= SYMBOL && r.height <= SYMBOL);
    const straight = !round && !symbol && points(el) < SERIES;
    // A level or upright straight line is a gridline or an axis.
    if (straight && Math.min(r.width, r.height) < 2) return null;
    const ctm = el.getScreenCTM();
    const scale = ctm ? Math.hypot(ctm.a, ctm.b) : 1;
    const opacity = opacityOf(el, svg);
    const fill = solid(cs.fill, +cs.fillOpacity * opacity) && symbol && el.tagName !== 'line';
    const width = (parseFloat(cs.strokeWidth) || 0) * scale;
    const long = round || Math.max(r.width, r.height) >= SPAN;
    const stroke = solid(cs.stroke, +cs.strokeOpacity * opacity) && width > 0 && width <= WIDE && long;
    if (!fill && !stroke) return null;
    const kind = fill ? 'a dot' : round ? 'a ring' : 'a line';
    const closed = el.tagName === 'path' && /z\s*$/i.test(el.getAttribute('d') ?? '');
    const node = closed && r.width <= NODE && r.height <= NODE && points(el) <= SIDES;
    return { el, r, fill, stroke, kind, round, node, straight, pad: width / 2, clip: clipOf(el, svg) };
  }

  /**
   * The screen box a mark’s clip-path leaves it, or null for none: a chart clips a line it draws past its plot, and a
   * hit test reads the whole line. Read from the clip’s shapes in the user space of what it clips, its default units.
   * @param {Element} el @param {Element} svg
   */
  function clipOf(el, svg) {
    for (let e = el; e && e !== svg; e = e.parentElement) {
      const id = getComputedStyle(e).clipPath.match(/url\(["']?#([^"')]+)["']?\)/)?.[1];
      const clip = id && document.getElementById(id);
      const ctm = clip && /** @type {SVGGraphicsElement} */ (e).getScreenCTM?.();
      if (!clip || !ctm) continue;
      // A clip in the box’s own units, or one transformed, isn’t read here: no box, so the mark is tested whole.
      if (clip.getAttribute('clipPathUnits') === 'objectBoundingBox' || clip.hasAttribute('transform')) return null;
      if ([...clip.children].some((c) => c.hasAttribute('transform'))) return null;
      const corners = [...clip.children].flatMap((c) => {
        const b = /** @type {SVGGraphicsElement} */ (c).getBBox?.();
        return b ? [new DOMPoint(b.x, b.y), new DOMPoint(b.x + b.width, b.y + b.height)].map((p) => p.matrixTransform(ctm)) : [];
      });
      if (!corners.length) continue;
      const xs = corners.map((p) => p.x);
      const ys = corners.map((p) => p.y);
      return { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };
    }
    return null;
  }

  /** How many points a line passes through: a polyline’s, a line’s two, a path’s commands, or a bare moveto’s pairs. */
  function points(el) {
    if (el.tagName === 'polyline') return el.points.numberOfItems;
    if (el.tagName === 'line') return 2;
    const d = el.getAttribute('d') ?? '';
    const commands = d.match(/[MLHVCSQTA]/gi)?.length ?? 0;
    // Only a bare moveto lists further points with no letters (“M0 0 10 10 20 20”); a curve’s numbers are its controls.
    if (commands > 1) return commands;
    return Math.floor((d.match(/-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi)?.length ?? 0) / 2);
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
      const ctm = el.getScreenCTM();
      // The band runs across the text, so its height scales with the vertical axis.
      const size = parseFloat(cs.fontSize) * (ctm ? Math.hypot(ctm.c, ctm.d) : 1);
      out.push({ el, t, r, inset: Math.max(EDGE, size * CORE) });
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
    if (performance.now() > deadline) return 0;
    const ctm = mark.el.getScreenCTM();
    if (!ctm) return 0;
    const inv = ctm.inverse();
    let n = 0;
    for (let y = label.r.top + label.inset; y <= label.r.bottom - label.inset; y += STEP)
      for (let x = label.r.left + EDGE; x <= label.r.right - EDGE; x += STEP) {
        if (mark.clip && (x < mark.clip.left || x > mark.clip.right || y < mark.clip.top || y > mark.clip.bottom)) continue;
        const p = new DOMPoint(x, y).matrixTransform(inv);
        if ((mark.fill && mark.el.isPointInFill(p)) || (mark.stroke && mark.el.isPointInStroke(p))) n++;
        if (n >= HITS) return n;
      }
    return n;
  }

  let deadline = 0;
  /** text-over-marks, for each SVG that isn’t inside another one, until its time runs out. */
  function textOverMarks() {
    hidden.reset();
    deadline = performance.now() + BUDGET;
    const out = [];
    for (const svg of document.querySelectorAll('svg')) {
      if (svg.parentElement.closest('svg') || hidden(svg)) continue;
      const all = marks(svg);
      const on = [];
      for (const l of labels(svg, backings(svg))) {
        // A label inside its own dot, ring or node, such as a count or a name, is that mark’s label, not one drawn over
        // it. A line’s box holds labels that aren’t its own.
        const own = (m) => (m.round || m.node) && within(l.r, m.r);
        const under = all.find((m) => meets(l.r, m.r, m.pad) && !own(m) && hits(l, m) >= HITS);
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
