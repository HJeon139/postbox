// Whether an app’s text can be read, for the pre-display check (app/kit/check.js): its contrast with what’s behind it,
// and its size. Postbox inlines it into a check frame’s page after check-controls.js, and before check.js, which calls
// what it adds to window.__pbCheck. Its names stay in the block, as strict mode keeps a function declared in one there,
// so they can’t clash with the app’s.
// biome-ignore lint/suspicious/noRedundantUseStrict: the page runs this as a classic script, which isn’t strict without it.
'use strict';
{
  const { rgb, lum, clip, where, jump, hidden } = window.__pbCheck;
  // The smallest text a person can read at a glance: the critique’s floor (VE12). An SVG drawn a little under its
  // viewBox’s size draws a 12 px label at 11.7 px, which reads the same, so a label counts as small under 11.5 px.
  const MIN_SIZE = 12;
  const SMALL = 11.5;

  /**
   * contrast: text whose contrast with what’s behind it is under WCAG AA, up to 3: page text against its nearest opaque
   * background, and SVG labels against the shape drawn under them (#997).
   */
  function lowContrast() {
    hidden.reset();
    const out = [];
    const y0 = scrollY;
    for (const l of labels()) {
      if (out.length >= 3) break;
      const cs = getComputedStyle(l.el);
      const svg = l.el.closest('svg');
      const fg = svg ? rgb(cs.fill) : rgb(cs.color);
      if (!fg) continue;
      if (svg) fg.a *= +cs.fillOpacity;
      const bg = svg ? behind(l.el) : background(l.el);
      const ratio = contrast(blend(fg, bg), bg);
      const large = l.size >= 24 || (l.size >= 18.66 && +cs.fontWeight >= 700);
      if (ratio < (large ? 3 : 4.5))
        out.push({
          code: 'contrast',
          message: `Text “${clip(l.t)}” (${where(l.el)}) has contrast ${ratio.toFixed(2)}:1 with what’s behind it; it needs ${large ? 3 : 4.5}:1. Set text in var(--text) or var(--dim), and keep colors for the marks.`,
        });
    }
    jump(y0);
    return out;
  }
  // What’s painted under an SVG label: its own halo (a wide stroke painted first, as d3 draws one), else the first
  // opaque shape or box under its middle, else the page behind the SVG.
  const SHAPES = new Set(['rect', 'circle', 'ellipse', 'path', 'polygon', 'polyline']);
  function behind(el) {
    const cs = getComputedStyle(el);
    const halo = rgb(cs.stroke);
    if (halo && halo.a > 0.95 && parseFloat(cs.strokeWidth) >= 2 && cs.paintOrder.startsWith('stroke')) return halo;
    let r = el.getBoundingClientRect();
    if (r.top < 0 || r.bottom > innerHeight) {
      jump(scrollY + r.top - innerHeight / 2);
      r = el.getBoundingClientRect();
    }
    const stack = document.elementsFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    for (const e of stack.slice(stack.indexOf(el) + 1)) {
      const c = paintOf(e);
      if (c && c.a > 0.95) return c;
    }
    return background(el.closest('svg'));
  }
  // What an element paints: a shape its fill, a page element its background, and an SVG’s other parts nothing.
  function paintOf(e) {
    const s = getComputedStyle(e);
    if (SHAPES.has(e.tagName.toLowerCase())) {
      const c = rgb(s.fill);
      return c && { ...c, a: c.a * +s.fillOpacity };
    }
    return e.closest('svg') ? null : rgb(s.backgroundColor);
  }
  function background(el) {
    for (let e = el; e; e = e.parentElement) {
      const c = rgb(getComputedStyle(e).backgroundColor);
      if (c && c.a > 0.95) return c;
    }
    return rgb(getComputedStyle(document.documentElement).backgroundColor) || { r: 0, g: 0, b: 0, a: 1 };
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

  Object.assign(window.__pbCheck, { lowContrast, smallText });
}
