// Whether an app’s text can be read, for the pre-display check (app/kit/check.js): its contrast with what’s behind it,
// and its size. Postbox inlines it into a check frame’s page after check-controls.js, and before check.js, which calls
// what it adds to window.__pbCheck. Its names stay in the block, as strict mode keeps a function declared in one there,
// so they can’t clash with the app’s.
// biome-ignore lint/suspicious/noRedundantUseStrict: the page runs this as a classic script, which isn’t strict without it.
'use strict';
{
  const { rgb, lum, clip, where, hidden, guard } = window.__pbCheck;
  // The smallest text a person can read at a glance: the critique’s floor (VE12). An SVG drawn a little under its
  // viewBox’s size draws a 12 px label at 11.7 px, which reads the same, so a label counts as small under 11.5 px.
  const MIN_SIZE = 12;
  const SMALL = 11.5;

  /**
   * contrast: text whose contrast with what’s behind it is under WCAG AA, up to 3: page text against its nearest opaque
   * background, and SVG labels against what’s painted under them (#997). A label whose background the check can’t
   * measure is left unjudged: a wrong guess sent agents to darken white text on a dark shape.
   */
  function lowContrast() {
    hidden.reset();
    const out = [];
    const [x0, y0] = [scrollX, scrollY];
    for (const l of labels()) {
      if (out.length >= 3) break;
      const cs = getComputedStyle(l.el);
      const svg = l.el.closest('svg');
      const fg = svg ? rgb(cs.fill) : rgb(cs.color);
      if (!fg) continue;
      if (svg) fg.a *= +cs.fillOpacity;
      const under = svg ? behind(l.el) : background(l.el);
      if (!under) continue;
      const ratio = contrast(blend(fg, under.c), under.c);
      const large = l.size >= 24 || (l.size >= 18.66 && +cs.fontWeight >= 700);
      if (ratio < (large ? 3 : 4.5))
        out.push({
          code: 'contrast',
          message: `Text “${clip(l.t)}” (${where(l.el)}) has contrast ${ratio.toFixed(2)}:1 with ${under.on ? `the fill of ${under.on}` : 'the page behind it'}; it needs ${large ? 3 : 4.5}:1. ${under.on ? 'Set dark text on a light fill and light text on a dark one, or put the label beside the mark.' : 'Set text in var(--text) or var(--dim), and keep colors for the marks.'}`,
        });
    }
    scrollTo({ left: x0, top: y0, behavior: 'instant' });
    return out;
  }

  // What’s painted under an SVG label, as { c, on }, with on naming the shape; or null when the check can’t tell. A
  // label’s own halo (a wide stroke painted first, as d3 draws one) is what’s behind it. Otherwise the page scrolls the
  // label into view, and the first thing painted under its middle decides. A gradient or pattern, a shape drawn by
  // <use>, an image, a translucent paint, a label the page can’t scroll to (in a box that scrolls sideways), or nothing
  // under it at all can’t be measured.
  function behind(el) {
    const cs = getComputedStyle(el);
    const halo = rgb(cs.stroke);
    if (halo && halo.a > 0.95 && parseFloat(cs.strokeWidth) >= 2 && cs.paintOrder.startsWith('stroke')) return { c: halo, on: null };
    let r = el.getBoundingClientRect();
    const off = () => r.left < 0 || r.top < 0 || r.right > innerWidth || r.bottom > innerHeight;
    if (off()) {
      scrollTo({ left: scrollX + r.left - innerWidth / 2, top: scrollY + r.top - innerHeight / 2, behavior: 'instant' });
      r = el.getBoundingClientRect();
    }
    if (off()) return null;
    const [x, y] = [r.left + r.width / 2, r.top + r.height / 2];
    for (const e of document.elementsFromPoint(x, y)) {
      if (el.contains(e) || e.closest('text')) continue;
      const p = paintAt(e, x, y);
      if (p === CLEAR) continue;
      return p && p.a > 0.95 ? { c: p, on: SHAPES.has(e.tagName.toLowerCase()) ? where(e) : null } : null;
    }
    return null;
  }
  // What an element paints at a point: CLEAR where it paints nothing, a color, or null where the check can’t tell. A
  // shape paints its stroke or its fill there, as its geometry says; an SVG’s groups paint nothing of their own.
  const CLEAR = 'clear';
  const SHAPES = new Set(['rect', 'circle', 'ellipse', 'path', 'polygon', 'polyline', 'line']);
  function paintAt(e, x, y) {
    const s = getComputedStyle(e);
    const tag = e.tagName.toLowerCase();
    if (SHAPES.has(tag)) {
      const m = e.getScreenCTM()?.inverse();
      if (!m) return null;
      const pt = new DOMPoint(x, y).matrixTransform(m);
      let [paint, opacity] = ['none', 1];
      if (e.isPointInStroke(pt)) [paint, opacity] = [s.stroke, s.strokeOpacity];
      else if (e.isPointInFill(pt)) [paint, opacity] = [s.fill, s.fillOpacity];
      if (paint === 'none') return CLEAR;
      const c = rgb(paint);
      return c && { ...c, a: c.a * +opacity * seen(e) };
    }
    if (e instanceof SVGElement && tag !== 'svg') return ['g', 'a', 'foreignobject'].includes(tag) ? CLEAR : null;
    if (s.backgroundImage !== 'none') return null;
    const c = rgb(s.backgroundColor);
    return !c || c.a < 0.05 ? CLEAR : c;
  }
  // How much of an SVG shape shows: its opacity and its groups’, up to its SVG.
  function seen(e) {
    let o = 1;
    for (let a = e; a && a.tagName.toLowerCase() !== 'svg'; a = a.parentElement) o *= +getComputedStyle(a).opacity;
    return o;
  }
  // The nearest opaque background behind page text, as { c }, or null when a background image comes first.
  function background(el) {
    for (let e = el; e; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.backgroundImage !== 'none') return null;
      const c = rgb(cs.backgroundColor);
      if (c && c.a > 0.95) return { c };
    }
    return { c: rgb(getComputedStyle(document.documentElement).backgroundColor) || { r: 0, g: 0, b: 0, a: 1 } };
  }
  function blend(f, b) {
    return { r: f.r * f.a + b.r * (1 - f.a), g: f.g * f.a + b.g * (1 - f.a), b: f.b * f.a + b.b * (1 - f.a), a: 1 };
  }
  function contrast(a, b) {
    const x = lum(a),
      y = lum(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  }

  // Shown, at a size, and not hidden for screen readers only (clipped to 1 px, as .sr-only text is).
  const shown = (el) => {
    const b = el.getBoundingClientRect();
    if (b.width <= 1 || b.height <= 1) return false;
    const cs = getComputedStyle(el);
    return !hidden(el) && cs.clip === 'auto' && cs.clipPath === 'none';
  };
  // How much an SVG element is scaled on screen, from its user units.
  const scale = (el) => {
    const m = el.getScreenCTM?.();
    return m ? Math.hypot(m.a, m.b) : 1;
  };
  const tenth = (n) => Math.round(n * 10) / 10;

  // Every label the person reads, with the size it’s drawn at: SVG labels at their scaled size, and page text at its
  // font size. KaTeX sets its own sizes, its limits and indices among them.
  function labels() {
    const out = [];
    for (const el of document.querySelectorAll('svg text'))
      if (!el.parentElement.closest('text') && el.textContent.trim() && shown(el))
        out.push({ el, t: el.textContent, size: parseFloat(getComputedStyle(el).fontSize) * scale(el) });
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const seen = new Set();
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const el = n.parentElement;
      if (!n.textContent.trim() || !el || seen.has(el) || el.closest('svg, script, style, .katex') || !shown(el)) continue;
      seen.add(el);
      out.push({ el, t: n.textContent, size: parseFloat(getComputedStyle(el).fontSize) });
    }
    return out;
  }

  /**
   * text-too-small: labels under 12 px, the critique’s floor (VE12), named, the smallest first. A subscript or a
   * superscript is part of a label, set smaller on purpose. The code says when it’s measured at a width other than
   * the one the floor names: at 375 px, where an SVG scaled to fit draws its labels small, it’s a warning (server/apps.mjs).
   */
  function smallText(w, code = 'text-too-small') {
    hidden.reset();
    const all = labels();
    const small = all.filter((l) => l.size < SMALL && !l.el.closest('sub, sup')).sort((a, b) => a.size - b.size);
    if (!small.length) return [];
    const such = small.slice(0, 3).map((l) => `“${clip(l.t)}” (${where(l.el)}) at ${tenth(l.size)} px`);
    return [
      {
        code,
        message: `At ${w} px, ${small.length} of ${all.length} labels are under ${MIN_SIZE} px, such as ${such.join(', ')}. Set text at ${MIN_SIZE} px or more. Where a chart has no room for its labels at that size, label fewer of its marks, or let it grow.`,
      },
    ];
  }

  // The box of an element’s own text: an SVG label’s, or the lines of a page element’s own text nodes.
  const range = document.createRange();
  function textBox(el) {
    if (el.closest('svg')) return el.getBoundingClientRect();
    let [left, top, right, bottom] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const c of el.childNodes) {
      if (c.nodeType !== 3 || !c.textContent.trim()) continue;
      range.selectNodeContents(c);
      for (const r of range.getClientRects())
        [left, top, right, bottom] = [Math.min(left, r.left), Math.min(top, r.top), Math.max(right, r.right), Math.max(bottom, r.bottom)];
    }
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  }
  // Cut short on purpose: an ellipsis, or a clamp to a number of lines.
  const shortened = (el) => {
    for (let e = el; e && e !== document.body; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.textOverflow === 'ellipsis' || (cs.webkitLineClamp && cs.webkitLineClamp !== 'none')) return true;
    }
    return false;
  };
  // What cuts a label short: the element, an SVG’s edge, or another ancestor whose overflow is hidden, or the page’s
  // top or left edge, where no one can scroll. A box that scrolls doesn’t cut: you scroll to the rest. A label cut away
  // whole is hidden on purpose (a carousel’s other slides, a closed accordion).
  function cutBy(el, r) {
    let { left, top, right, bottom } = r;
    let by = null;
    const cut = (l, t, rt, b, who) => {
      if (l > left + 2 || t > top + r.height / 3 || rt < right - 2 || b < bottom - r.height / 3) by = by ?? who;
      [left, top, right, bottom] = [Math.max(left, l), Math.max(top, t), Math.min(right, rt), Math.min(bottom, b)];
    };
    for (let a = el; a && a !== document.documentElement; a = a.parentElement) {
      const cs = getComputedStyle(a);
      const x = /hidden|clip/.test(cs.overflowX);
      const y = /hidden|clip/.test(cs.overflowY);
      if (!x && !y) continue;
      const b = a.getBoundingClientRect();
      cut(x ? b.left : -Infinity, y ? b.top : -Infinity, x ? b.right : Infinity, y ? b.bottom : Infinity, where(a));
    }
    cut(-scrollX, -scrollY, Infinity, Infinity, 'the page’s edge');
    return right - left > 0 && bottom - top > 0 ? by : null;
  }

  /** text-cut-off: labels cut short by what holds them, up to 3. */
  function cutOff(w) {
    hidden.reset();
    const out = [];
    for (const l of labels()) {
      if (out.length >= 3) break;
      const by = !shortened(l.el) && cutBy(l.el, textBox(l.el));
      if (by)
        out.push({
          code: 'text-cut-off',
          message: `At ${w} px, “${clip(l.t)}” (${where(l.el)}) is cut off by ${by}. Give it room: move it inside, make the box bigger, or let the box’s overflow show.`,
        });
    }
    return out;
  }

  Object.assign(window.__pbCheck, { lowContrast, smallText, cutOff: guard('text-cut-off', cutOff) });
}
