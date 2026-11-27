// Text run into a control, and words broken mid-word (#681), for the layout check of Postbox’s own screens, which
// tools/text-layout.mjs runs beside check-layout.js’s text-overlap and text-overflow and check-text.js’s text-cut-off,
// so Postbox’s screens and agents’ apps are held to one rule. It runs after check-layout.js and check-text.js, whose helpers it takes
// from window.__pbCheck, and adds its own there. Its names stay in the block, as strict mode keeps a function declared
// in one there, so they can’t clash with the page’s.
// biome-ignore lint/suspicious/noRedundantUseStrict: the page runs this as a classic script, which isn’t strict without it.
'use strict';
{
  const { clip, px, where, jump, hidden, shown, shownPart, lineBoxes, opaque, guard } = window.__pbCheck;
  const CONTROLS = 'button, [role=button], [role=checkbox], [role=radio], [role=tab], a[href], input:not([type=hidden]), select, textarea, summary';
  const range = document.createRange();

  // Each line of each shown control, as much of it as its ancestors let show: a link that wraps is two boxes, not the
  // box around both lines.
  function controlBoxes() {
    const out = [];
    for (const el of document.querySelectorAll(CONTROLS)) {
      if (hidden(el)) continue;
      for (const r of el.getClientRects()) {
        const s = shownPart(el, r);
        if (s.width > 1 && s.height > 1) out.push({ el, r: s });
      }
    }
    return out;
  }

  // How far two boxes cross, or null: more than 2 × 2 px, and a good part of the lower one’s height, as text-overlap
  // counts it (check-layout.js), so a control’s padding grazing the line above doesn’t count.
  function crossing(a, b) {
    const x = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    return x > 2 && y > 2 && y >= Math.min(a.height, b.height) / 3 ? { x, y } : null;
  }

  // Whether the text and the control both show where they meet: one under something opaque (a dialog over the page’s
  // buttons, a sticky bar over the controls scrolled under it) is hidden there. A control on top hides the text under
  // its opaque box, as Jump to latest floats over the transcript (#681), and so does a control the text belongs to. The
  // text’s own box otherwise hides the control only when it covers it whole: text on a badge over part of a button is
  // a collision, and a dialog’s text over a button it hides isn’t. Asking what’s at a point skips what ignores the
  // pointer, which still shows, so the question is asked with every element taking the pointer.
  function bothShow(textEl, control, x, y, y0) {
    jump(y < 0 || y > innerHeight ? y + y0 - innerHeight / 2 : y0);
    const hit = document.head.appendChild(document.createElement('style'));
    hit.textContent = '* { pointer-events: auto !important; }';
    const stack = document.elementsFromPoint(x, y + y0 - scrollY);
    hit.remove();
    const covers = (e, el) => {
      const [a, b] = [e.getBoundingClientRect(), el.getBoundingClientRect()];
      return a.left <= b.left && a.top <= b.top && a.right >= b.right && a.bottom >= b.bottom;
    };
    const hides = (e, el) => {
      if (e.contains(el) || !opaque(e)) return false;
      const textsOwn = el === control && (e === textEl || textEl.contains(e));
      return !textsOwn || e.closest(CONTROLS) !== null || covers(e, el);
    };
    const under = (el) => {
      const i = stack.indexOf(el);
      return i > 0 && stack.slice(0, i).some((e) => hides(e, el));
    };
    return !under(textEl) && !under(control);
  }

  // Text that belongs to the control: its own, and its labels’.
  const belongs = (n, control) => control.contains(n) || [...(control.labels ?? [])].some((l) => l.contains(n));
  const named = (el) => {
    const label = el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || '';
    return label.trim() ? `“${clip(label)}”` : el.tagName.toLowerCase();
  };

  /**
   * text-on-control: text drawn across a control it doesn’t belong to, up to 3, the first of each pair of them. It asks
   * what’s drawn where at most 200 times, as text-overlap does (check-layout.js), so a dialog over a page of buttons
   * doesn’t run past the wait.
   */
  function textOnControl(w) {
    hidden.reset();
    const y0 = scrollY;
    const found = new Map();
    let asks = 0;
    const texts = lineBoxes();
    for (const c of controlBoxes()) {
      for (const t of texts) {
        if (found.size >= 3 || t.r.top >= c.r.bottom) break;
        const cross = crossing(t.r, c.r);
        const key = `${clip(t.n.textContent)}\u0000${where(c.el)}`;
        if (!cross || found.has(key) || belongs(t.n, c.el) || asks++ >= 200) continue;
        const at = [(Math.max(t.r.left, c.r.left) + Math.min(t.r.right, c.r.right)) / 2, (Math.max(t.r.top, c.r.top) + Math.min(t.r.bottom, c.r.bottom)) / 2];
        if (!bothShow(t.n.parentElement, c.el, at[0], at[1], y0)) continue;
        found.set(key, {
          code: 'text-on-control',
          message: `At ${w} px, “${clip(t.n.textContent)}” (${where(t.n.parentElement)}) runs into the control ${named(c.el)} (${where(c.el)}) by ${px(cross.x)} × ${px(cross.y)} px. Give the text room, or move the control off it.`,
        });
      }
    }
    jump(y0);
    return [...found.values()];
  }

  // A word is a run of letters and digits. A soft hyphen, a zero-width space or a <wbr> between them is a place the
  // text asks to break, so it ends a word there, as a space or a hyphen does.
  const WORD = /[\p{L}\p{N}]+/gu;
  // The fewest characters of a word a line may hold by itself: fewer is a word read a few letters at a time (#680).
  const MIN_PART = 4;
  // Text whose element asks the browser to hyphenate it breaks where the browser chose to (#681).
  const asked = (el) => getComputedStyle(el).hyphens === 'auto';

  // How many characters of a word each line holds, in order. A character starts a new line when it starts below the
  // middle of the one before.
  function partsOf(n, start, end) {
    const parts = [];
    let [top, height] = [-Infinity, 0];
    for (let i = start, k = 1; i < end; i += k) {
      // A character outside the Basic Multilingual Plane is two code units.
      k = n.textContent.codePointAt(i) > 0xffff ? 2 : 1;
      range.setStart(n, i);
      range.setEnd(n, i + k);
      const r = range.getBoundingClientRect();
      if (!r.height) continue;
      if (r.top > top + height / 2) {
        parts.push('');
        [top, height] = [r.top, r.height];
      }
      parts[parts.length - 1] += range.toString();
    }
    return parts;
  }

  // Whether a word’s first character starts its line: the text before it, in its node or the one before, is on a
  // line above. Text set to break anywhere (word-break: break-all) fills a line before it breaks a word, so a short
  // first part after other text isn’t a word read alone.
  function startsLine(n, start) {
    const before = n.textContent.slice(0, start).trimEnd();
    let [node, at] = [n, before.length];
    if (!at) {
      const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      walk.currentNode = n;
      for (node = walk.previousNode(); node && !node.textContent.trim(); node = walk.previousNode());
      if (!node) return true;
      at = node.textContent.trimEnd().length;
    }
    range.setStart(node, at - 1);
    range.setEnd(node, at);
    const prev = range.getBoundingClientRect();
    range.setStart(n, start);
    range.setEnd(n, start + 1);
    const first = range.getBoundingClientRect();
    return !prev.height || prev.top + prev.height / 2 < first.top;
  }

  // The first part of a word in a text node that a line holds by itself and is under MIN_PART characters, with its
  // word, or null. A word’s last part is what’s left over when a long one wraps, and is often short.
  function shortPart(n) {
    for (const m of n.textContent.matchAll(WORD)) {
      const end = m.index + m[0].length;
      range.setStart(n, m.index);
      range.setEnd(n, end);
      if (m[0].length < 2 || range.getClientRects().length < 2) continue;
      const parts = partsOf(n, m.index, end);
      const short = parts.findIndex((p, i) => i < parts.length - 1 && [...p].length < MIN_PART && (i > 0 || startsLine(n, m.index)));
      if (short >= 0) return { word: m[0], part: parts[short] };
    }
    return null;
  }

  /** mid-word-break: a word broken mid-word with a part under MIN_PART characters on a line by itself, up to 3. */
  function midWordBreaks(w) {
    hidden.reset();
    const out = [];
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n && out.length < 3; n = walk.nextNode()) {
      const el = n.parentElement;
      if (!el || !n.textContent.trim() || el.closest('script, style, svg, .katex') || !shown(el) || asked(el)) continue;
      const found = shortPart(n);
      if (found)
        out.push({
          code: 'mid-word-break',
          message: `At ${w} px, “${clip(found.word)}” (${where(el)}) breaks mid-word, leaving “${found.part}” on a line by itself. Give it room to fit whole, or let it scroll.`,
        });
    }
    return out;
  }

  Object.assign(window.__pbCheck, {
    textOnControl: guard('text-on-control', textOnControl),
    midWordBreaks: guard('mid-word-break', midWordBreaks),
  });
}
