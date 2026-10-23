// Layout problems for the pre-display check (app/kit/check.js), which a page-level overflow test misses because they
// stay inside the page: text that spills out of its own box or over other text (#194), and controls you can’t see or
// click (#89). Postbox inlines it into a check frame’s page between the kit and check.js, which calls what it adds
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

  // What of a box its ancestors let show: each one whose overflow isn’t visible cuts it to its own box.
  function shownPart(el, r) {
    let { left, top, right, bottom } = r;
    for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
      const b = a.getBoundingClientRect();
      if (cs.overflowX !== 'visible') [left, right] = [Math.max(left, b.left), Math.min(right, b.right)];
      if (cs.overflowY !== 'visible') [top, bottom] = [Math.max(top, b.top), Math.min(bottom, b.bottom)];
    }
    return { left, top, right, bottom, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
  }

  /** text-overflow: an element that holds text itself, lets it overflow (overflow-x: visible), and is narrower than it. */
  function textOverflow(w) {
    const out = [];
    for (const el of document.body.querySelectorAll('*')) {
      if (out.length >= 3) break;
      if (el.closest('svg') || hidden(el)) continue;
      const text = ownText(el);
      if (!text || !el.clientWidth || el.scrollWidth <= el.clientWidth + 1 || getComputedStyle(el).overflowX !== 'visible') continue;
      out.push({
        code: 'text-overflow',
        message: `At ${w} px, “${clip(text)}” is ${el.scrollWidth} px wide in a ${el.clientWidth} px box, so it spills out of it. Let it wrap (remove white-space: nowrap), or give its grid column minmax(0, …).`,
      });
    }
    return out;
  }

  // The line boxes of every visible text node, SVG labels too, cut to what their ancestors let show.
  function lineBoxes() {
    const boxes = [];
    const range = document.createRange();
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const el = n.parentElement;
      if (!n.textContent.trim() || !el || el.closest('script, style') || hidden(el)) continue;
      range.selectNodeContents(n);
      for (const r of range.getClientRects()) {
        const s = shownPart(el, r);
        if (s.width > 0 && s.height > 0) boxes.push({ n, r: s });
      }
    }
    return boxes.sort((a, b) => a.r.top - b.r.top);
  }

  /** text-overlap: text from two nodes drawn over each other by more than 2 × 2 px, keyed by the two texts. */
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
    if (y < 0 || y > innerHeight) scrollTo(0, y + y0 - innerHeight / 2);
    else scrollTo(0, y0);
    const stack = document.elementsFromPoint(x, y + y0 - scrollY);
    const under = (el) => {
      const i = stack.indexOf(el);
      return i > 0 && stack.slice(0, i).some((e) => !e.contains(el) && opaque(e));
    };
    return !under(a.n.parentElement) && !under(b.n.parentElement);
  }

  function textOverlaps() {
    hiddenMemo.clear();
    const found = new Map();
    const boxes = lineBoxes();
    const y0 = scrollY;
    for (let i = 0; i < boxes.length; i++) {
      const a = boxes[i];
      for (let j = i + 1; j < boxes.length && boxes[j].r.top < a.r.bottom; j++) {
        const b = boxes[j];
        if (a.n === b.n) continue;
        const x = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
        const y = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
        // Lines set tight can touch by a few pixels; text over text covers a good part of a line’s height.
        if (x <= 2 || y <= 2 || y < Math.min(a.r.height, b.r.height) / 3) continue;
        const key = `${clip(a.n.textContent)}\u0000${clip(b.n.textContent)}`;
        const mid = [(Math.max(a.r.left, b.r.left) + Math.min(a.r.right, b.r.right)) / 2, (Math.max(a.r.top, b.r.top) + Math.min(a.r.bottom, b.r.bottom)) / 2];
        if (!found.has(key) && bothShow(a, b, mid[0], mid[1], y0)) found.set(key, { a: clip(a.n.textContent), b: clip(b.n.textContent), x: px(x), y: px(y) });
      }
    }
    scrollTo(0, y0);
    return found;
  }

  /**
   * text-overlap, measured twice about a second apart: an overlap counts only when it’s there both times, so labels a
   * transition is still moving into place aren’t reported.
   */
  function textOverlap(w) {
    const first = textOverlaps();
    return new Promise((r) => setTimeout(r, 1000)).then(() => {
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

  // ── Controls you can’t see or click (#89) ────────────────────────────────────────────

  // The class names Postbox’s own stylesheet defines (the page’s first style), which an app’s markup takes on with them.
  let postboxClasses = null;
  function ours(el) {
    if (!postboxClasses) {
      postboxClasses = new Set();
      const walk = (rules) => {
        for (const r of rules) {
          for (const m of (r.selectorText ?? '').matchAll(/\.([\w-]+)/g)) postboxClasses.add(m[1]);
          if (r.cssRules) walk(r.cssRules);
        }
      };
      walk(document.querySelector('head > style')?.sheet?.cssRules ?? []);
    }
    return [...el.classList].filter((c) => postboxClasses.has(c));
  }
  const tag = (el) =>
    el.tagName.toLowerCase() +
    [...el.classList]
      .slice(0, 3)
      .map((c) => `.${c}`)
      .join('');
  const name = (el) => {
    const kind = el.matches('a[href]') ? 'link' : el.matches('input, select, textarea') ? 'field' : 'button';
    const label = el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || el.value || '';
    return label.trim() ? `the ${kind} “${clip(label)}”` : `a ${kind}`;
  };

  // The ancestor that cuts a control down to under half of it, or under 8 px across. A scroll container doesn’t count
  // when it’s big enough to scroll in: you can scroll to what it hides.
  function clippedBy(el, r) {
    let { left, top, right, bottom } = r;
    for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
      const cs = getComputedStyle(a);
      const x = cs.overflowX !== 'visible';
      const y = cs.overflowY !== 'visible';
      const b = a.getBoundingClientRect();
      if ((!x && !y) || (/auto|scroll/.test(cs.overflowX + cs.overflowY) && b.width >= 8 && b.height >= 8)) continue;
      if (x) [left, right] = [Math.max(left, b.left), Math.min(right, b.right)];
      if (y) [top, bottom] = [Math.max(top, b.top), Math.min(bottom, b.bottom)];
      const w = Math.max(0, right - left);
      const h = Math.max(0, bottom - top);
      if (w < Math.min(8, r.width) || h < Math.min(8, r.height) || w * h < (r.width * r.height) / 2) {
        const mine = ours(a);
        const by = `${tag(a)}, which is ${px(b.width)} × ${px(b.height)} px with overflow: ${cs.overflow}`;
        const fix = mine.length
          ? `; .${mine.join(', .')} is a class of Postbox’s own stylesheet, so give yours a prefix of your own (such as app-${mine[0]}).`
          : '. Let it grow, or let it scroll.';
        return { key: a, why: `clipped to ${px(w)} × ${px(h)} px by ${by}${fix}` };
      }
    }
    return null;
  }

  // What’s drawn over the middle of a control, where a click would land instead. The page scrolls to it first.
  function coveredBy(el) {
    let r = el.getBoundingClientRect();
    if (r.top < 0 || r.bottom > innerHeight) {
      scrollBy(0, r.top + r.height / 2 - innerHeight / 2);
      r = el.getBoundingClientRect();
    }
    // Scrolled out of view in a container, it’s reachable by scrolling there.
    const s = shownPart(el, r);
    if (!s.width || !s.height || s.top < 0 || s.bottom > innerHeight) return null;
    const hit = document.elementFromPoint(s.left + s.width / 2, s.top + s.height / 2);
    if (!hit || el.contains(hit) || hit.contains(el) || (el.labels && [...el.labels].some((l) => l.contains(hit)))) return null;
    return { key: hit, why: `under ${tag(hit)}, which takes its clicks. Move one of them, or give the covering element pointer-events: none.` };
  }

  const CONTROLS = 'button, [role=button], [role=checkbox], [role=radio], [role=tab], a[href], input:not([type=hidden]), select, textarea, summary';
  /** control-hidden: a control with no size, clipped by an ancestor, or under another element at its middle. */
  function controlHidden(w) {
    hiddenMemo.clear();
    const y0 = scrollY;
    const groups = new Map();
    for (const el of document.querySelectorAll(CONTROLS)) {
      if (!el.getClientRects().length || hidden(el)) continue;
      const cs = getComputedStyle(el);
      // Visually hidden on purpose, for screen readers (clip or clip-path), as a custom checkbox’s input is.
      if (cs.clip !== 'auto' || cs.clipPath !== 'none') continue;
      const r = el.getBoundingClientRect();
      const found =
        r.width < 1 || r.height < 1
          ? { key: 'size', why: `${px(r.width)} × ${px(r.height)} px, with no size to see or click.` }
          : clippedBy(el, r) || coveredBy(el);
      if (!found) continue;
      if (!groups.has(found.key)) groups.set(found.key, { n: 0, el, why: found.why });
      groups.get(found.key).n++;
    }
    scrollTo(0, y0);
    return [...groups.values()].slice(0, 3).map((g) => ({
      code: 'control-hidden',
      message: `At ${w} px, ${g.n === 1 ? `${name(g.el)} is` : `${g.n} controls, such as ${name(g.el)}, are`} ${g.why}`,
    }));
  }

  Object.assign(window.__pbCheck, { textOverflow, textOverlap, controlHidden });
})();
