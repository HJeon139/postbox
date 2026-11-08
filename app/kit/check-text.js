// Whether an app’s text can be read, for the pre-display check (app/kit/check.js): its contrast with what’s behind it,
// and its size. Postbox inlines it into a check frame’s page after check-controls.js, and before check.js, which calls
// what it adds to window.__pbCheck. Its names stay in the block, as strict mode keeps a function declared in one there,
// so they can’t clash with the app’s.
// biome-ignore lint/suspicious/noRedundantUseStrict: the page runs this as a classic script, which isn’t strict without it.
'use strict';
{
  const { rgb, lum } = window.__pbCheck;

  // Text whose contrast with what’s behind it is under WCAG AA, up to 3.
  function lowContrast() {
    const out = [];
    let low = 0;
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const seen = new Set();
    for (let n = walk.nextNode(); n && low < 3; n = walk.nextNode()) {
      const el = n.parentElement;
      if (!n.textContent.trim() || !el || seen.has(el) || el.closest('svg')) continue;
      seen.add(el);
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) continue;
      const fg = rgb(cs.color);
      const bg = background(el);
      if (!fg || !bg) continue;
      const ratio = contrast(blend(fg, bg), bg);
      const size = parseFloat(cs.fontSize);
      const large = size >= 24 || (size >= 18.66 && +cs.fontWeight >= 700);
      if (ratio < (large ? 3 : 4.5)) {
        low++;
        out.push({
          code: 'contrast',
          message: `Text “${n.textContent.trim().slice(0, 30)}” has contrast ${ratio.toFixed(2)}:1; it needs ${large ? 3 : 4.5}:1.`,
        });
      }
    }
    return out;
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

  const shown = (el) => {
    const b = el.getBoundingClientRect();
    if (!b.width && !b.height) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && +cs.opacity !== 0;
  };
  // How much an SVG element is scaled on screen, from its user units.
  const scale = (el) => {
    const m = el.getScreenCTM?.();
    return m ? Math.hypot(m.a, m.b) : 1;
  };
  const px = (n) => Math.round(n * 10) / 10;

  // Text: SVG labels at their scaled size, and page text at its font size.
  function smallText(w) {
    const out = [];
    const sizes = [];
    for (const el of document.querySelectorAll('svg text'))
      if (shown(el) && el.textContent.trim()) sizes.push(parseFloat(getComputedStyle(el).fontSize) * scale(el));
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const seen = new Set();
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const el = n.parentElement;
      if (!n.textContent.trim() || !el || el.closest('svg') || !shown(el)) continue;
      if (seen.has(el)) continue;
      seen.add(el);
      sizes.push(parseFloat(getComputedStyle(el).fontSize));
    }
    const small = sizes.filter((s) => s < 9);
    if (small.length >= 3 && small.length / sizes.length >= 0.2)
      out.push({
        code: 'text-too-small',
        message: `At ${w} px, ${small.length} of ${sizes.length} labels are drawn under 9 px (the smallest at ${px(Math.min(...small))} px), too small to read. Make them larger, or show fewer.`,
      });
    return out;
  }

  Object.assign(window.__pbCheck, { lowContrast, smallText });
}
