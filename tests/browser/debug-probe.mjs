// Debug only, for #963: what moves the side panel's scroll box as a thread opens at 375 px.

const script = () => {
  const vlog = (/** @type {any[]} */ e) => {
    /** @type {any} */ (window).__vlog ||= [];
    /** @type {any} */ (window).__vlog.push(e);
  };
  const log = (/** @type {string} */ w) => vlog([w, String(new Error().stack).split('\n').slice(2, 7).join(' | ')]);
  const d = /** @type {PropertyDescriptor} */ (Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop'));
  Object.defineProperty(Element.prototype, 'scrollTop', {
    get: d.get,
    set(x) {
      if (this.classList?.contains('sp-body')) log(`set ${x} from ${this.scrollTop}`);
      d.set?.call(this, x);
    },
    configurable: true,
  });
  for (const [C, m] of /** @type {[any, string][]} */ ([
    [Element, 'scrollIntoView'],
    [Element, 'scrollBy'],
    [Element, 'scrollTo'],
    [HTMLElement, 'focus'],
  ])) {
    const o = C.prototype[m];
    C.prototype[m] = function (/** @type {any[]} */ ...a) {
      log(`${m} ${this.tagName}.${this.className} ${JSON.stringify(a)}`);
      return o.apply(this, a);
    };
  }
  const key = () => {
    const b = document.querySelector('.sidepanel .sp-body');
    return b ? `${b.scrollTop}/${b.scrollHeight}/${b.clientHeight}` : '';
  };
  let last = '';
  const frame = () => {
    const k = key();
    if (k && k !== last) vlog([`raf ${k}`]);
    last = k;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  new MutationObserver((rs) => {
    const near = rs.filter((r) => /** @type {any} */ (r.target).closest?.('.sidepanel'));
    if (!near.length) return;
    const what = near
      .slice(0, 4)
      .map(
        (r) =>
          `${r.type}:${/** @type {any} */ (r.target).className || r.target.nodeName}:+${r.addedNodes.length}-${r.removedNodes.length}${r.attributeName ? `@${r.attributeName}` : ''}`,
      );
    vlog([`mut ${key()} ${what.join(',')}`]);
  }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  addEventListener(
    'scroll',
    (e) => {
      const b = /** @type {any} */ (e.target);
      if (b?.classList?.contains('sp-body')) vlog([`scroll-event ${key()}`]);
    },
    true,
  );
};

/** @param {import('@playwright/test').Page} page */
export const probe = (page) => page.addInitScript(script);
