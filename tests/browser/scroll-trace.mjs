// A trace of scroll writes and scroll events in the page, by frame, for view-skipped-smooth.spec.mjs: CI's runners
// stepped back from the end of the jump to the end where the build host didn't (#959), and the trace says whether
// anything of the page's wrote the step. The frame is the spec's own count, smoothYs.length - 1.

/** Starts the trace, or clears it, in the page. @param {any} page */
export const traceScrolls = (page) =>
  page.evaluate(() => {
    const w = /** @type {any} */ (window);
    // Every scroll write in the page and every scroll event, by frame, with the line that wrote it: on a step back the
    // case attaches those around it (CI's runners step back where the build host doesn't; #959).
    w.scrollTrace = [];
    const note = (/** @type {string} */ kind, /** @type {any} */ to) =>
      w.scrollTrace.push({
        f: (w.smoothYs?.length ?? 1) - 1,
        kind,
        y: Math.round(scrollY),
        h: document.documentElement.scrollHeight,
        to: typeof to === 'object' ? JSON.stringify(to) : to,
        at: kind.startsWith('write')
          ? (new Error().stack ?? '')
              .split('\n')
              .find((l) => l.includes('/app/js/'))
              ?.trim()
          : undefined,
      });
    if (!w.scrollHooked) {
      w.scrollHooked = true;
      const { scrollTo, scrollBy } = window;
      window.scrollTo = function (...a) {
        note('write scrollTo', a[0]);
        return scrollTo.apply(this, a);
      };
      window.scrollBy = function (...a) {
        note('write scrollBy', a[0]);
        return scrollBy.apply(this, a);
      };
      const top = /** @type {PropertyDescriptor} */ (Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop'));
      Object.defineProperty(Element.prototype, 'scrollTop', {
        configurable: true,
        get() {
          return top.get?.call(this);
        },
        set(v) {
          if (this === document.scrollingElement) note('write scrollTop', Math.round(v));
          top.set?.call(this, v);
        },
      });
      addEventListener('scroll', () => note('scroll'), { passive: true });
      addEventListener('scrollend', () => note('scrollend'));
    }
  });

/** The trace around each step back, from two frames before it to the frame it lands in. */
export const traceNear = (page, back) =>
  page.evaluate(
    (frames) => /** @type {any[]} */ (/** @type {any} */ (window).scrollTrace ?? []).filter((t) => frames.some((f) => t.f >= f - 2 && t.f <= f)),
    back.map((/** @type {any} */ b) => b.frame),
  );
