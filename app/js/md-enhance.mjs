// Mermaid diagrams, each in its own sandboxed frame, and KaTeX math in rendered Markdown: agents' replies, a review's
// draft, the side panel. apps.mjs re-exports enhanceMarkdown.

import { MIN_TEXT_PX } from '/shared/diagram-lint.mjs';
import { api } from './client.mjs';
import { h } from './dom.mjs';
import { libSource, theme } from './sandbox-libs.mjs';

export function enhanceMarkdown(root) {
  for (const fig of root.querySelectorAll('figure.md-mermaid:not(.done)')) drawDiagram(fig);
  drawMath(root);
}

/** Puts a Mermaid figure's source in a sandboxed frame that draws it, with Show source. @param {Element} fig */
function drawDiagram(fig) {
  fig.classList.add('done');
  const src = fig.textContent;
  const pre = h('pre.mono', { hidden: true }, src);
  // Sandboxed by the policy the page is served with, like the apps.
  const iframe = h('iframe', { title: 'Diagram', src: `/sandbox/mermaid?theme=${theme()}`, referrerpolicy: 'no-referrer' });
  const btn = h(
    'button.btn.sm.ghost',
    {
      type: 'button',
      'aria-expanded': 'false',
      onclick: () => {
        pre.hidden = !pre.hidden;
        btn.textContent = pre.hidden ? 'Show source' : 'Hide source';
        btn.setAttribute('aria-expanded', String(!pre.hidden));
      },
    },
    'Show source',
  );
  const box = h('figure.diagram', h('div.d-bar', h('span.label.grow', 'Diagram'), btn), iframe, pre);
  fig.replaceWith(box);
  listen(iframe, box, src);
}

/** Answers a diagram frame's messages: the library when it's ready, its errors and its size. */
function listen(iframe, box, src) {
  const onMsg = (e) => {
    if (e.source !== iframe.contentWindow || e.data?.__pbd !== 1 || e.origin !== 'null') return;
    if (e.data.type === 'ready')
      libSource('mermaid').then(({ js }) => iframe.contentWindow?.postMessage({ __pbd: 1, type: 'render', src, label: 'Diagram', lib: js }, '*'));
    const itemEl = box.closest('[data-key]');
    const threadId = box.closest('[data-thread]')?.dataset.thread;
    // A diagram that couldn’t be drawn goes to the server, once, so the agent hears Mermaid’s message and can
    // fix it. The person still sees the frame’s “couldn’t be drawn” text and Show source.
    if (e.data.type === 'error' && e.data.render && itemEl && threadId) {
      if (!iframe.dataset.failed) {
        iframe.dataset.failed = '1';
        const error = { message: String(e.data.message ?? ''), line: e.data.line ?? null };
        api(`/api/threads/${threadId}/items/${itemEl.dataset.key}/diagram`, { src, error }).catch(() => {});
      }
    } else if (e.data.type === 'error') console.error(`Diagram: ${e.data.message}`);
    if (e.data.type === 'size') {
      iframe.style.height = `${Math.min(e.data.height, 900)}px`;
      iframe.dataset.sized = '1';
      // Too small to read: tell the server, once per diagram, so the agent can redraw it.
      if (typeof e.data.textPx === 'number') iframe.dataset.textPx = String(e.data.textPx);
      if (e.data.textPx < MIN_TEXT_PX && itemEl && threadId && !iframe.dataset.reported) {
        iframe.dataset.reported = '1';
        api(`/api/threads/${threadId}/items/${itemEl.dataset.key}/diagram`, { src, textPx: e.data.textPx, width: e.data.width }).catch(() => {});
      }
    }
    if (!iframe.isConnected) removeEventListener('message', onMsg);
  };
  addEventListener('message', onMsg);
}

/** Draws each formula in root not drawn yet with KaTeX, loaded the first time. @param {Element} root */
function drawMath(root) {
  const math = root.querySelectorAll('.md-math:not(.rendered)');
  if (math.length)
    loadKatex()
      .then((katex) => {
        for (const el of math) {
          const tex = el.textContent;
          try {
            katex.render(tex, el, { displayMode: el.dataset.display === 'true', throwOnError: false, trust: false, strict: 'ignore' });
            // KaTeX writes MathML beside the visual math, which is what screen readers read.
            el.classList.add('rendered');
            // A wide formula scrolls sideways in a narrow column; the keyboard has to be able to scroll it too.
            if (el.dataset.display === 'true')
              requestAnimationFrame(() => {
                if (el.scrollWidth > el.clientWidth + 1) el.tabIndex = 0;
              });
          } catch {
            /* leave the source visible */
          }
        }
      })
      .catch(() => {});
}

let katexP = null;
function loadKatex() {
  katexP ??= new Promise((resolve, reject) => {
    document.head.append(h('link', { rel: 'stylesheet', href: '/kit/vendor/katex/katex.min.css' }));
    const s = h('script', { src: '/kit/vendor/katex/katex.min.js' });
    s.onload = () => resolve(window.katex);
    s.onerror = reject;
    document.head.append(s);
  });
  return katexP;
}
