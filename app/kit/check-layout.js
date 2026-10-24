// Text problems for the pre-display check (app/kit/check.js), which a page-level overflow test misses because they
// stay inside the page: text that spills out of its own box, and text drawn over other text (#194). Postbox inlines it
// into a check frame’s page after the kit; check-controls.js (#89) uses its helpers, and check.js calls what they add
// to window.__pbCheck.
(function () {
  // A check frame is hidden off screen, where the browser runs no animation frames, so an app’s transitions (d3’s)
  // would never finish, and their labels would stay where they started. Here they run on a timer instead.
  window.requestAnimationFrame = (fn) => setTimeout(() => fn(performance.now()), 16);
  window.cancelAnimationFrame = (id) => clearTimeout(id);
  const clip = (s) => {
    const t = String(s).trim().replace(/\s+/g, ' ');
    return t.length > 40 ? `${t.slice(0, 40)}…` : t;
  };
  const px = (n) => Math.round(n);
  // Scrolls at once, whatever the app’s scroll-behavior: the check measures right after.
  const jump = (top) => scrollTo({ top, behavior: 'instant' });
  const ownText = (el) =>
    [...el.childNodes]
      .filter((c) => c.nodeType === 3 && c.textContent.trim())
      .map((c) => c.textContent)
      .join(' ');

  // Hidden on purpose: display none, visibility hidden, or opacity 0 on it or an ancestor (a label a transition fades in).
  const hiddenMemo = new Map();
  function hidden(el) {
    if (!el || el === document.documentElement) return false;
    if (hiddenMemo.has(el)) return hiddenMemo.get(el);
    const cs = getComputedStyle(el);
    const out = cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0 || hidden(el.parentElement);
    hiddenMemo.set(el, out);
    return out;
  }
  hidden.reset = () => hiddenMemo.clear();

  // What of a box its ancestors let show (and, for text, its own element): each one whose overflow isn’t visible cuts
  // it to its own box, so text cut short with an ellipsis, or hidden for screen readers, is only what shows.
  function shownPart(el, r, self = false) {
    let { left, top, right, bottom } = r;
    for (let a = self ? el : el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
      const b = a.getBoundingClientRect();
      if (cs.overflowX !== 'visible') [left, right] = [Math.max(left, b.left), Math.min(right, b.right)];
      if (cs.overflowY !== 'visible') [top, bottom] = [Math.max(top, b.top), Math.min(bottom, b.bottom)];
    }
    return { left, top, right, bottom, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
  }

  // Math KaTeX sets is built of glyphs placed over each other on purpose (a hat over a y, limits over a sum).
  const SKIP = 'script, style, svg, .katex';
  const range = document.createRange();
  // How far an element’s own text reaches past its padding box, and how wide that text is. Measured from the text, not
  // scrollWidth, which also counts a badge positioned past the element’s corner.
  function spill(el) {
    let l = Infinity;
    let r = -Infinity;
    for (const c of el.childNodes) {
      if (c.nodeType !== 3 || !c.textContent.trim()) continue;
      range.selectNodeContents(c);
      for (const b of range.getClientRects()) [l, r] = [Math.min(l, b.left), Math.max(r, b.right)];
    }
    const b = el.getBoundingClientRect();
    const inner = b.left + el.clientLeft;
    return { past: Math.max(r - (inner + el.clientWidth), inner - l), width: r - l };
  }
  // Text in a box that scrolls sideways (a <pre> in an overflow-x: auto wrapper) can be scrolled to.
  const scrolls = (el) => {
    for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) if (/auto|scroll/.test(getComputedStyle(a).overflowX)) return true;
    return false;
  };

  /** text-overflow: an element that holds text itself, lets it overflow (overflow-x: visible), and is narrower than it. */
  function textOverflow(w) {
    hidden.reset();
    const out = [];
    for (const el of document.body.querySelectorAll('*')) {
      if (out.length >= 3) break;
      if (el.closest(SKIP) || hidden(el)) continue;
      const text = ownText(el);
      if (!text || !el.clientWidth || el.scrollWidth <= el.clientWidth + 1 || getComputedStyle(el).overflowX !== 'visible') continue;
      const s = spill(el);
      if (s.past <= 1 || scrolls(el)) continue;
      out.push({
        code: 'text-overflow',
        message: `At ${w} px, “${clip(text)}” is ${px(s.width)} px wide in a ${el.clientWidth} px box, so it spills out of it. Let it wrap (remove white-space: nowrap), or give its grid column minmax(0, …).`,
      });
    }
    return out;
  }

  // The line boxes of every visible text node, SVG labels too, cut to what their ancestors let show. A box is the font’s
  // whole height, room for accents and descenders; set tighter than that (a 40 px figure at line-height .9), only its
  // line’s height counts, so the line below it doesn’t overlap it.
  function lineBoxes() {
    const boxes = [];
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const el = n.parentElement;
      if (!n.textContent.trim() || !el || el.closest('script, style, .katex') || hidden(el)) continue;
      // A rotated label’s boxes are upright, so they’d cross its neighbors’: it isn’t measured.
      const m = el.closest('svg') && el.getScreenCTM?.();
      if (m && Math.abs(m.b) > 0.01) continue;
      const lh = parseFloat(getComputedStyle(el).lineHeight);
      range.selectNodeContents(n);
      for (const r of range.getClientRects()) {
        const mid = (r.top + r.bottom) / 2;
        const tight = lh < r.height ? { left: r.left, right: r.right, top: mid - lh / 2, bottom: mid + lh / 2 } : r;
        const s = shownPart(el, tight, true);
        if (s.width > 0 && s.height > 0) boxes.push({ n, r: s });
      }
    }
    return boxes.sort((a, b) => a.r.top - b.r.top);
  }

  // Whether both texts show where they meet: one painted over by something opaque of another’s (a list scrolled under
  // its sticky footer) is hidden there, not overlapped.
  const opaque = (e) => {
    const m = getComputedStyle(e).backgroundColor.match(/rgba?\(([^)]+)\)/);
    const p = m
      ? m[1]
          .split(/[ ,/]+/)
          .filter(Boolean)
          .map(Number)
      : [];
    return p.length >= 3 && (p[3] ?? 1) > 0.95;
  };
  function bothShow(a, b, x, y, y0) {
    // Only off screen: scrolling moves a sticky footer, and with it what overlaps.
    jump(y < 0 || y > innerHeight ? y + y0 - innerHeight / 2 : y0);
    const stack = document.elementsFromPoint(x, y + y0 - scrollY);
    const under = (el) => {
      const i = stack.indexOf(el);
      return i > 0 && stack.slice(0, i).some((e) => !e.contains(el) && opaque(e));
    };
    return !under(a.n.parentElement) && !under(b.n.parentElement);
  }

  /**
   * text-overlap: text from two nodes drawn over each other by more than 2 × 2 px, keyed by the two texts. It stops at
   * 20 of them, a million pairs or 200 questions of what’s drawn where, so a page of labels stacked in one place, or of
   * cards stacked over each other, doesn’t run past the host’s wait.
   */
  function textOverlaps() {
    hidden.reset();
    const found = new Map();
    const boxes = lineBoxes();
    const y0 = scrollY;
    let pairs = 0;
    let asks = 0;
    for (let i = 0; i < boxes.length && found.size < 20 && pairs < 1e6 && asks < 200; i++) {
      const a = boxes[i];
      for (let j = i + 1; j < boxes.length && boxes[j].r.top < a.r.bottom; j++, pairs++) {
        const b = boxes[j];
        // The same label drawn twice in one place is a halo (a stroke behind it, as d3 draws one), not an overlap.
        const halo = a.n.textContent === b.n.textContent && Math.abs(a.r.left - b.r.left) < 2 && Math.abs(a.r.top - b.r.top) < 2;
        if (a.n === b.n || halo) continue;
        const x = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
        const y = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
        // Lines set tight can touch by a few pixels; text over text covers a good part of a line’s height.
        if (x <= 2 || y <= 2 || y < Math.min(a.r.height, b.r.height) / 3) continue;
        const key = `${clip(a.n.textContent)}\u0000${clip(b.n.textContent)}`;
        const mid = [(Math.max(a.r.left, b.r.left) + Math.min(a.r.right, b.r.right)) / 2, (Math.max(a.r.top, b.r.top) + Math.min(a.r.bottom, b.r.bottom)) / 2];
        if (found.has(key) || asks++ >= 200) continue;
        if (bothShow(a, b, mid[0], mid[1], y0)) found.set(key, { a: clip(a.n.textContent), b: clip(b.n.textContent), x: px(x), y: px(y) });
      }
    }
    jump(y0);
    return found;
  }

  /**
   * text-overlap, measured twice about a second apart: an overlap counts only when it’s there both times, so labels a
   * transition is still moving into place aren’t reported.
   */
  function textOverlap(w) {
    const first = textOverlaps();
    // A hidden frame’s timers fire on the next whole second, so 900 ms comes to about a second; 1,000 came to two.
    return new Promise((r) => setTimeout(r, 900)).then(() => {
      const out = [];
      for (const [key, o] of textOverlaps())
        if (first.has(key) && out.length < 3)
          out.push({
            code: 'text-overlap',
            message: `At ${w} px, “${o.a}” is drawn over “${o.b}” (${o.x} × ${o.y} px). Give the text room: let it wrap, or make its column wider.`,
          });
      return out;
    });
  }

  // A check that throws loses only its own problems, not the rest of the check at this width, and says so: check-error
  // is Postbox’s, so it’s shown as a note and never sent to the agent to fix (server/apps.mjs).
  const guard = (code, fn) => (w) => {
    const failed = (e) => [{ code: 'check-error', message: `At ${w} px, Postbox couldn’t check for ${code}: ${e?.message ?? e}` }];
    try {
      return Promise.resolve(fn(w)).catch(failed);
    } catch (e) {
      return Promise.resolve(failed(e));
    }
  };
  Object.assign(window.__pbCheck, {
    textOverflow: guard('text-overflow', textOverflow),
    textOverlap: guard('text-overlap', textOverlap),
    ...{ clip, px, jump, hidden, shownPart, guard },
  });
})();
