// The first view, for the pre-display check (app/kit/check.js), #997: at 1000 × 680, the size a visual is read at,
// the title and the figure are on screen before any scrolling (the critique’s VE8). Postbox runs it in a frame of its
// own at that size (app/js/app-check.mjs), and inlines it into a check frame’s page after check-text.js.
// biome-ignore lint/suspicious/noRedundantUseStrict: the page runs this as a classic script, which isn’t strict without it.
'use strict';
{
  const { clip, px, where, jump, hidden, guard } = window.__pbCheck;
  // The share of the figure that must show. Measured on the first versions of 175 apps from past UAT runs: 166 show
  // all of it, 3 show 90% or more (an axis or a caption past the edge), and 6 show less, a figure the reader scrolls to.
  const SHOWN = 0.9;
  const area = (r) => r.width * r.height;

  // The figure: the largest picture on the page, an SVG, canvas, image or video at least 100 px each way.
  function figure() {
    const all = [...document.querySelectorAll('svg, canvas, img, video')]
      .filter((el) => !el.parentElement.closest('svg') && !hidden(el))
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.width >= 100 && r.height >= 100);
    return all.sort((a, b) => area(b.r) - area(a.r))[0];
  }

  /** first-view: the title, and most of the figure, aren’t on screen before any scrolling. */
  function firstView() {
    hidden.reset();
    const y0 = scrollY;
    jump(0);
    const size = `${innerWidth} × ${innerHeight}`;
    const out = [];
    const title = [...document.querySelectorAll('h1, h2, [role=heading]')].find((el) => !hidden(el) && el.textContent.trim());
    const t = title?.getBoundingClientRect();
    if (t && t.bottom > innerHeight + 1)
      out.push({
        code: 'first-view',
        message: `At ${size} px, the title “${clip(title.textContent)}” (${where(title)}) ends ${px(t.bottom)} px down, below the first view. Put the title at the top.`,
      });
    const fig = figure();
    const shown = fig ? Math.max(0, Math.min(innerHeight, fig.r.bottom) - Math.max(0, fig.r.top)) / fig.r.height : 1;
    if (shown < SHOWN)
      out.push({
        code: 'first-view',
        message: `At ${size} px, before any scrolling, ${Math.round(shown * 100)}% of the figure (${where(fig.el)}, ${px(fig.r.width)} × ${px(fig.r.height)} px, from ${px(fig.r.top)} to ${px(fig.r.bottom)} px down) is on screen. Make it shorter, or move what sits above it (controls, notes) beside or below it, so the title and the whole figure show at once.`,
      });
    jump(y0);
    return out;
  }

  window.__pbCheck.firstView = guard('first-view', firstView);
}
