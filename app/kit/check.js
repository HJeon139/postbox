// The pre-display check: it runs in the hidden frames at 375 and 1280 px that check an app before you see it,
// and posts what it finds, which goes to the agent. Postbox inlines it after the kit, and only into a check frame’s
// page (server/sandbox.mjs); the kit hands it what it shares with the rest of the kit.
(function () {
  const { ready, errors, post, rgb, lum, textOverflow, textOverlap, controlHidden, classCollisions } = window.__pbCheck;
  delete window.__pbCheck;
  // ── The pre-display check ─────────────────────────────────────────────────────────────
  // Run inside hidden frames at 375 and 1280 px before you see the app. Problems go to the agent.
  // Wait until the layout stops changing (charts and lists render after their data arrives).
  const quiet = () =>
    new Promise((resolve) => {
      let last = -1,
        still = 0;
      const t = setInterval(() => {
        const sig = document.documentElement.scrollWidth * 100000 + document.documentElement.scrollHeight;
        still = sig === last ? still + 1 : 0;
        last = sig;
        if (still >= 3) {
          clearInterval(t);
          resolve();
        }
      }, 200);
      setTimeout(() => {
        clearInterval(t);
        resolve();
      }, 6000);
    });
  ready
    .then(() => new Promise((r) => setTimeout(r, 600)))
    .then(quiet)
    // Text over text is measured twice, a second apart, and the other layout problems once (check-layout.js, check-controls.js).
    .then(() => Promise.all([textOverlap(innerWidth), textOverflow(innerWidth), controlHidden(innerWidth), classCollisions(innerWidth)]))
    .then(([overlaps, overflows, hiddenControls, collisions]) => {
      const problems = [];
      const w = innerWidth;
      const sw = document.documentElement.scrollWidth;
      if (sw > w + 1) problems.push({ code: `overflow-${w}`, message: `At ${w} px wide the content is ${sw} px wide, so it scrolls sideways.` });
      const named = (el) =>
        el.getAttribute('aria-label') ||
        el.getAttribute('aria-labelledby') ||
        el.getAttribute('title') ||
        (el.textContent || '').trim() ||
        (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) ||
        el.closest('label');
      document.querySelectorAll('input:not([type=hidden]), select, textarea').forEach((el) => {
        if (
          !(
            el.getAttribute('aria-label') ||
            el.getAttribute('aria-labelledby') ||
            (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) ||
            el.closest('label') ||
            el.getAttribute('title')
          )
        ) {
          problems.push({ code: 'unlabeled-field', message: `A ${el.tagName.toLowerCase()} has no label.` });
        }
      });
      document.querySelectorAll('button, [role=button], [role=checkbox], [role=radio], a[href]').forEach((el) => {
        if (!named(el)) problems.push({ code: 'unlabeled-control', message: 'A button or link has no text or label.' });
      });
      document.querySelectorAll('img:not([alt])').forEach(() => {
        problems.push({ code: 'missing-alt', message: 'An image has no alt text.' });
      });
      document.querySelectorAll('[tabindex]').forEach((el) => {
        if (+el.getAttribute('tabindex') > 0)
          problems.push({ code: 'tab-order', message: 'An element sets a positive tabindex, which breaks keyboard order.' });
      });
      problems.push(...lowContrast(), ...legibility(w), ...overflows, ...overlaps, ...hiddenControls, ...collisions);
      for (const e of errors) problems.push({ code: 'script-error', message: e });
      post({ type: 'check', width: w, problems });
    });
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
  // Legibility: SVG marks, labels and dash patterns too small to read at this width, and an app that shows only an
  // error. These are warnings: the app is still shown, and the agent is told.
  function legibility(w) {
    const out = [];
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
    let marks = 0;
    let tiny = 0;
    let dashed = 0;
    let finest = Infinity;
    for (const el of document.querySelectorAll('svg circle, svg rect, svg ellipse, svg path, svg line, svg polyline, svg polygon')) {
      if (el.closest('defs, clipPath, mask, marker, pattern, symbol') || !shown(el)) continue;
      const cs = getComputedStyle(el);
      const stroked = cs.stroke !== 'none' && parseFloat(cs.strokeWidth) > 0;
      if (cs.fill === 'none' && !stroked) continue;
      const b = el.getBoundingClientRect();
      marks++;
      if (Math.max(b.width, b.height) < 4) tiny++;
      if (stroked && cs.strokeDasharray && cs.strokeDasharray !== 'none' && !cs.strokeDasharray.includes('%')) {
        const k = scale(el);
        const parts = cs.strokeDasharray
          .split(/[\s,]+/)
          .map(parseFloat)
          .filter((n) => n > 0);
        const dash = Math.min(...parts) * k;
        const width = parseFloat(cs.strokeWidth) * k;
        if (parts.length && (dash < 2 || width < 1)) {
          dashed++;
          finest = Math.min(finest, dash, width);
        }
      }
    }
    if (tiny >= 20 && tiny / marks >= 0.25)
      out.push({
        code: 'marks-too-small',
        message: `At ${w} px, ${tiny} of ${marks} marks are under 4 px across, too small to see or point at. Draw fewer, larger marks (group, sample or bin them), or let the person filter or zoom.`,
      });
    if (dashed)
      out.push({
        code: 'dashes-too-fine',
        message: `At ${w} px, ${dashed} dashed ${dashed === 1 ? 'line has' : 'lines have'} dashes, gaps or strokes of ${px(finest)} px, too fine to tell from a solid line. Use dashes of at least 4 px, gaps of 3 px and lines 1 px wide, or tell the series apart by color and a label.`,
      });
    // Text: SVG labels at their scaled size, and page text at its font size.
    const sizes = [];
    for (const el of document.querySelectorAll('svg text'))
      if (shown(el) && el.textContent.trim()) sizes.push(parseFloat(getComputedStyle(el).fontSize) * scale(el));
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const seen = new Set();
    const words = [];
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const el = n.parentElement;
      if (!n.textContent.trim() || !el || el.closest('svg') || !shown(el)) continue;
      words.push(n.textContent);
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
    // An app that shows only an error or a missing-data message hasn’t worked, even if nothing else is wrong.
    const said = words.join(' ').trim().replace(/\s+/g, ' ');
    const content = marks || document.querySelector('canvas, table tr, input, select, textarea, img');
    if (said && said.length < 300 && !content && ONLY_ERROR.test(said))
      out.push({
        code: 'only-error',
        message: `It shows only “${said.slice(0, 120)}”, which reads as an error or missing data. Make sure the data it needs is there, or say what the person can do.`,
      });
    return out;
  }
  const ONLY_ERROR = /\b(?:error|failed|isn[’']t loaded|not loaded|restart postbox|no data|missing|couldn[’']t|could not|can[’']t load|unable to|not found)\b/i;
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
})();
