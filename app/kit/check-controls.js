// Controls you can’t see or click, for the pre-display check (app/kit/check.js): control-hidden (#89). Postbox inlines
// it into a check frame’s page after check-layout.js, whose helpers it takes from window.__pbCheck, and before check.js.
(function () {
  const { clip, px, jump, hidden, shownPart, guard } = window.__pbCheck;

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
    // A field is named by its label, not its value (a radio’s is “on”).
    const label = el.getAttribute('aria-label') || el.labels?.[0]?.textContent || el.textContent || el.getAttribute('placeholder') || '';
    return label.trim() ? `the ${kind} “${clip(label)}”` : `a ${kind}`;
  };

  // The ancestor that cuts a control down to under half of it, or under 8 px across, while some of it still shows. One
  // cut away entirely is hidden on purpose (a carousel’s other slides, an accordion closed at max-height: 0), and a
  // scroll container big enough to scroll in doesn’t count on the axis it scrolls: you can scroll to what it hides.
  function clippedBy(el, r) {
    let { left, top, right, bottom } = r;
    for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
      const cs = getComputedStyle(a);
      const b = a.getBoundingClientRect();
      const cuts = (v) => v !== 'visible' && !(/auto|scroll/.test(v) && b.width >= 8 && b.height >= 8);
      const x = cuts(cs.overflowX);
      const y = cuts(cs.overflowY);
      if (!x && !y) continue;
      if (x) [left, right] = [Math.max(left, b.left), Math.min(right, b.right)];
      if (y) [top, bottom] = [Math.max(top, b.top), Math.min(bottom, b.bottom)];
      const w = Math.max(0, right - left);
      const h = Math.max(0, bottom - top);
      if (!w || !h) return null;
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
      jump(scrollY + r.top + r.height / 2 - innerHeight / 2);
      r = el.getBoundingClientRect();
    }
    // Scrolled out of view in a container, it’s reachable by scrolling there.
    const s = shownPart(el, r);
    if (!s.width || !s.height || s.top < 0 || s.bottom > innerHeight) return null;
    const hit = document.elementFromPoint(s.left + s.width / 2, s.top + s.height / 2);
    if (!hit || el.contains(hit) || hit.contains(el) || (el.labels && [...el.labels].some((l) => l.contains(hit)))) return null;
    // A watermark you can barely see still takes the clicks; what it needs is pointer-events: none.
    const faint = +getComputedStyle(hit).opacity < 0.2;
    return {
      key: hit,
      why: faint
        ? `under ${tag(hit)}, which is nearly transparent but takes its clicks. Give ${tag(hit)} pointer-events: none.`
        : `under ${tag(hit)}, which takes its clicks. Move one of them, or give the covering element pointer-events: none.`,
    };
  }

  // Why a shown control can’t be used, or null. No size in one direction is a squeezed control; none in either is one
  // collapsed on purpose (a menu at scale(0)), and a checkbox or radio at no size is a custom one’s hidden input.
  function unusable(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) {
      if ((r.width < 1 && r.height < 1) || el.matches('input[type=checkbox], input[type=radio]')) return null;
      return { key: 'size', why: `${px(r.width)} × ${px(r.height)} px, with no size to see or click.` };
    }
    return clippedBy(el, r) || coveredBy(el);
  }

  const CONTROLS = 'button, [role=button], [role=checkbox], [role=radio], [role=tab], a[href], input:not([type=hidden]), select, textarea, summary';
  /** control-hidden: a control with no size, clipped by an ancestor, or under another element at its middle. */
  function controlHidden(w) {
    hidden.reset();
    const y0 = scrollY;
    const groups = new Map();
    // An open modal dialog covers the page on purpose: only its own controls must be usable.
    const modal = document.querySelector('dialog:modal');
    for (const el of document.querySelectorAll(CONTROLS)) {
      if (!el.getClientRects().length || hidden(el) || (modal && !modal.contains(el))) continue;
      // Visually hidden on purpose, for screen readers (clip or clip-path), as a custom checkbox’s input is.
      const cs = getComputedStyle(el);
      if (cs.clip !== 'auto' || cs.clipPath !== 'none') continue;
      const found = unusable(el);
      if (!found) continue;
      if (!groups.has(found.key)) groups.set(found.key, { n: 0, el, why: found.why });
      groups.get(found.key).n++;
    }
    jump(y0);
    return [...groups.values()].slice(0, 3).map((g) => ({
      code: 'control-hidden',
      message: `At ${w} px, ${g.n === 1 ? `${name(g.el)} is` : `${g.n} controls, such as ${name(g.el)}, are`} ${g.why}`,
    }));
  }

  const KIT_CLASSES = new Set(['btn', 'sm', 'ghost', 'chip', 'on', 'pill', 'field', 'label', 'input', 'select', 'dim', 'small', 'mono', 'seg', 'tbl', 'katex']);
  function classCollisions() {
    const names = new Set();
    for (const el of document.body.querySelectorAll('[class]'))
      for (const name of ours(el)) if (!KIT_CLASSES.has(name) && !name.startsWith('pb-')) names.add(name);
    return [...names].slice(0, 5).map((name) => ({
      code: 'class-collision',
      message: `The class .${name} is also defined by Postbox’s stylesheet, so its shell styles change this app. Give the app’s class a prefix of its own, such as app-${name}.`,
    }));
  }

  window.__pbCheck.controlHidden = guard('control-hidden', controlHidden);
  window.__pbCheck.classCollisions = guard('class-collision', classCollisions);
})();
