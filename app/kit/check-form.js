// The form of an agent’s visual, for the pre-display check (app/kit/check.js): words set inside boxes, and marks that
// rank one number (#889). Agents draw blind (#95), and each rule written as prose became a loophole (#206): “no text in
// boxes” became Mermaid, “not bars” a lollipop sorted by one ratio. So both are measured from the page’s geometry, with
// no model. They are notes, not failures: the app is shown, and the agent hears what it drew (server/apps.mjs).
// Postbox inlines it into a check frame’s page after check-layout.js, whose helpers it takes from window.__pbCheck,
// and before check.js. Its code is in a block rather than a wrapping function, so Biome measures each function at the
// default length; a block’s const bindings stay out of the app’s global scope, where a function declaration wouldn’t.
{
  const { rgb, hidden, guard } = window.__pbCheck;
  const WORD = /\p{L}[\p{L}\p{N}’'-]*/gu;
  const wordsIn = (s) => (s.match(WORD) ?? []).length;
  // Words in controls, tables and code are the app’s interface and data, not its picture.
  const NOT_PICTURE = 'script, style, button, a, label, select, option, summary, table, pre, code, kbd, .katex';
  const PARKED = 'defs, clipPath, mask, marker, pattern, symbol';
  const area = (b) => b.width * b.height;
  const inBox = (x, y, b) => x >= b.left && x <= b.right && y >= b.top && y <= b.bottom;
  // A straight line’s box has no height (or width), and is shown all the same.
  const shown = (el) => {
    const b = el.getBoundingClientRect();
    return !hidden(el) && (b.width > 0 || b.height > 0);
  };
  const opaque = (c) => c && c.a > 0.5;

  // ── Text in shapes ───────────────────────────────────────────────────────────────────

  /** Every shown text node of the picture, with its words and the middle of its line boxes. */
  const texts = function () {
    const out = [];
    const range = document.createRange();
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const el = n.parentElement;
      const words = wordsIn(n.textContent);
      if (!words || !el || el.closest(NOT_PICTURE) || hidden(el)) continue;
      range.selectNodeContents(n);
      const b = range.getBoundingClientRect();
      if (area(b) > 0) out.push({ el, words, x: b.left + b.width / 2, y: b.top + b.height / 2, area: area(b) });
    }
    return out;
  };

  // The SVG shapes that can hold a label: closed, painted, and smaller than a quarter of their drawing (a larger one is
  // its background or plot area). A path counts only when it’s filled, since an open line encloses nothing.
  const svgShapes = function (svg) {
    const whole = area(svg.getBoundingClientRect());
    const out = [];
    for (const el of svg.querySelectorAll('rect, circle, ellipse, polygon, path')) {
      if (el.closest(PARKED) || !shown(el)) continue;
      const cs = getComputedStyle(el);
      const filled = cs.fill !== 'none' && +cs.fillOpacity > 0;
      const stroked = cs.stroke !== 'none' && parseFloat(cs.strokeWidth) > 0;
      if (!(filled || (stroked && el.tagName !== 'path'))) continue;
      const b = el.getBoundingClientRect();
      if (area(b) < whole / 4) out.push({ el, b, n: 0, words: 0 });
    }
    return out;
  };
  // Whether a point on screen is inside an SVG shape: its box first, then its geometry, unless it’s a rect.
  const holds = function (s, x, y) {
    if (!inBox(x, y, s.b)) return false;
    if (s.el.tagName === 'rect') return true;
    const m = s.el.getScreenCTM?.();
    return !m || s.el.isPointInFill(new DOMPoint(x, y).matrixTransform(m.inverse()));
  };

  // An HTML element drawn as a box: a border on every side, or a background of its own, and not as wide as the window
  // (a page band or a section isn’t a box in a picture). Inline highlights aren’t boxes.
  const boxMemo = new Map();
  const htmlBox = function (el) {
    if (boxMemo.has(el)) return boxMemo.get(el);
    const cs = getComputedStyle(el);
    const b = el.getBoundingClientRect();
    const sized = b.width >= 24 && b.height >= 16 && b.width <= innerWidth * 0.92 && cs.display !== 'inline';
    const side = (s) => parseFloat(cs[`border${s}Width`]) >= 1 && !/none|hidden/.test(cs[`border${s}Style`]) && opaque(rgb(cs[`border${s}Color`]));
    const bordered = ['Top', 'Right', 'Bottom', 'Left'].every(side);
    const own = rgb(cs.backgroundColor);
    const filled = opaque(own) && cs.backgroundColor !== behind(el.parentElement);
    const out = sized && (bordered || filled);
    boxMemo.set(el, out);
    return out;
  };
  const behind = function (el) {
    for (let e = el; e; e = e.parentElement) {
      const c = getComputedStyle(e).backgroundColor;
      if (opaque(rgb(c))) return c;
    }
    return getComputedStyle(document.documentElement).backgroundColor;
  };

  /** The box a text sits in: the smallest SVG shape around it that’s larger than it, or its nearest HTML box. */
  const boxOf = function (t, shapesOf) {
    const svg = t.el.closest('svg');
    if (svg) {
      let best = null;
      for (const s of shapesOf(svg)) if (area(s.b) >= t.area && holds(s, t.x, t.y) && (!best || area(s.b) < area(best.b))) best = s;
      return best;
    }
    for (let e = t.el; e && e !== document.body; e = e.parentElement) if (htmlBox(e)) return e;
    return null;
  };

  // A box holding more than this many words is a panel of prose, not a labeled shape: its words aren’t counted as boxed.
  const PROSE = 40;
  const WORDY = 6;
  /** text-in-shapes: most of the picture’s words sit inside boxes, or several boxes hold a sentence each. */
  const textInShapes = function (w) {
    hidden.reset();
    boxMemo.clear();
    const shapes = new Map();
    const shapesOf = (svg) => shapes.get(svg) ?? shapes.set(svg, svgShapes(svg)).get(svg);
    const boxes = new Map();
    let total = 0;
    for (const t of texts()) {
      total += t.words;
      const box = boxOf(t, shapesOf);
      if (box) boxes.set(box, (boxes.get(box) ?? 0) + t.words);
    }
    const held = [...boxes.values()].filter((n) => n <= PROSE);
    const boxed = held.reduce((a, n) => a + n, 0);
    const wordy = held.filter((n) => n > WORDY).length;
    const share = total ? boxed / total : 0;
    if (!(wordy >= 2 || (share >= 0.5 && held.length >= 4 && boxed >= 12))) return [];
    const most = wordy ? `, and ${wordy} of them hold more than ${WORDY} words` : '';
    return [
      {
        code: 'text-in-shapes',
        message: `At ${w} px, ${boxed} of ${total} words (${Math.round(share * 100)}%) sit inside ${held.length} boxes${most}: a diagram of labeled boxes. Draw what the things are or do, with short labels beside the marks, and explain in prose.`,
      },
    ];
  };

  // ── Ranking ──────────────────────────────────────────────────────────────────────────

  // The marks of a picture, grouped by kind: SVG shapes by their element, paint and drawing, and HTML boxes with no text
  // and a background (bars drawn as divs) by their class and color. A data series is one group.
  const markGroups = function () {
    const groups = new Map();
    const add = (key, el) => (groups.get(key) ?? groups.set(key, []).get(key)).push(el.getBoundingClientRect());
    const svgs = [...document.querySelectorAll('svg')];
    for (const el of document.querySelectorAll('svg rect, svg circle, svg ellipse, svg path, svg line, svg polygon')) {
      if (el.closest(PARKED) || !shown(el)) continue;
      const cs = getComputedStyle(el);
      if (cs.fill === 'none' && cs.stroke === 'none') continue;
      add(`${svgs.indexOf(el.closest('svg'))} ${el.tagName} ${cs.fill} ${cs.stroke}`, el);
    }
    for (const el of document.body.querySelectorAll('*')) {
      if (el.children.length || el.closest('svg') || el.closest(NOT_PICTURE) || (el.textContent ?? '').trim() || !shown(el)) continue;
      const bg = getComputedStyle(el).backgroundColor;
      if (opaque(rgb(bg))) add(`html ${el.className} ${bg}`, el);
    }
    return [...groups.values()].filter((g) => g.length >= 4 && g.length <= 500);
  };

  // Whether marks sit one to a row (or column), evenly spaced: the band axis of a bar chart or a dot plot.
  const banded = function (centers) {
    const c = [...centers].sort((a, b) => a - b);
    const steps = c.slice(1).map((v, i) => v - c[i]);
    const least = Math.min(...steps);
    return least >= 2 && Math.max(...steps) <= least * 1.6;
  };
  const spread = (v) => Math.max(...v) - Math.min(...v);
  const monotone = (v) => v.every((x, i) => !i || x >= v[i - 1] - 0.5) || v.every((x, i) => !i || x <= v[i - 1] + 0.5);

  /**
   * How a group of marks ranks one number, if it does: placed in evenly spaced rows (or columns), and along the other
   * axis either bars from one baseline whose lengths vary, or dots sorted by where they sit. A scatter varies on both
   * axes and a network has free positions, so neither has a band axis.
   */
  const ranking = function (boxes) {
    for (const rows of [true, false]) {
      const band = boxes.map((b) => (rows ? b.top + b.height / 2 : b.left + b.width / 2));
      if (!banded(band)) continue;
      const order = boxes.map((b, i) => ({ b, at: band[i] })).sort((p, q) => p.at - q.at);
      const lo = order.map(({ b }) => (rows ? b.left : b.bottom));
      const hi = order.map(({ b }) => (rows ? b.right : b.top));
      const len = order.map(({ b }) => (rows ? b.width : b.height));
      const based = spread(lo) <= 1.5 || spread(hi) <= 1.5;
      if (based && spread(len) >= 4 && Math.max(...len) >= Math.min(...len) * 1.15) return 'bars';
      const mid = order.map(({ b }) => (rows ? b.left + b.width / 2 : b.top + b.height / 2));
      if (spread(mid) >= 8 && monotone(mid)) return 'sorted';
    }
    return null;
  };

  /** ranks-one-number: a series of marks that varies along one position only. */
  const ranksOneNumber = function (w) {
    hidden.reset();
    const ranked = markGroups().filter((g) => ranking(g));
    if (!ranked.length) return [];
    const n = Math.max(...ranked.map((g) => g.length));
    return [
      {
        code: 'ranks-one-number',
        message: `At ${w} px, ${n} marks vary on one axis only, so this ranks one number. If the idea is how two things relate, place each mark by both; if it’s how things link, draw the links.`,
      },
    ];
  };

  window.__pbCheck.textInShapes = guard('text-in-shapes', textInShapes);
  window.__pbCheck.ranksOneNumber = guard('ranks-one-number', ranksOneNumber);
}
