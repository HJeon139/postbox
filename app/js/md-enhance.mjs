// Mermaid diagrams, each in its own sandboxed frame, and KaTeX math in rendered Markdown: agents' replies, a review's
// draft, the side panel. apps.mjs re-exports enhanceMarkdown.

import { MIN_TEXT_PX } from '/shared/diagram-lint.mjs';
import { api } from './client.mjs';
import { h } from './dom.mjs';
import { libSource, theme } from './sandbox-libs.mjs';

// Each drawn diagram's `message` listener, by its frame (#564). One whose frame has been in the page and has left it,
// with its reply drawn again or gone, is removed the next time a diagram is drawn or any message arrives. A frame
// drawn into a box that isn't in the page yet keeps its listener until it has been.
/** @type {Map<HTMLIFrameElement, { onMsg: (e: MessageEvent) => void, seen: boolean }>} */
const diagrams = new Map();
function dropGoneDiagrams() {
  for (const [iframe, d] of diagrams)
    if (iframe.isConnected) d.seen = true;
    else if (d.seen) {
      removeEventListener('message', d.onMsg);
      diagrams.delete(iframe);
    }
}

export function enhanceMarkdown(root) {
  dropGoneDiagrams();
  for (const fig of root.querySelectorAll('figure.md-mermaid:not(.done)')) drawDiagram(fig);
  drawMath(root);
}

/** Puts a Mermaid figure's source in a sandboxed frame that draws it, with Show source. @param {Element} fig */
function drawDiagram(fig) {
  fig.classList.add('done');
  const src = fig.textContent;
  const pre = h('pre.mono', { hidden: true }, src);
  // Sandboxed by the policy the page is served with, like the apps. It loads only as it nears the view (#695): each
  // frame runs all of Mermaid, and Safari runs frames on the page’s own thread, so a long room’s diagrams loading at
  // once held every keystroke for 40 s. So a broken or too-small diagram is reported to its agent (#573, onError and
  // onSize) only once its frame loads, not as its reply is drawn (#731).
  const iframe = h('iframe', { title: 'Diagram', src: `/sandbox/mermaid?theme=${theme()}`, referrerpolicy: 'no-referrer', loading: 'lazy' });
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

/** The diagram messages already swept for: each listener hears the same event, and one sweep does for all of them. */
const swept = new WeakSet();

/**
 * Answers a diagram frame's messages. Only the diagram protocol's (`__pbd`) count: they sweep the listeners whose
 * frames have gone, once per message, and the frame's own then goes to its handler by type.
 */
function listen(iframe, box, src) {
  const d = { iframe, box, src };
  const onMsg = (e) => {
    if (e.data?.__pbd !== 1) return;
    if (!swept.has(e)) {
      swept.add(e);
      dropGoneDiagrams();
    }
    if (e.source !== iframe.contentWindow || e.origin !== 'null') return;
    if (e.data.type === 'ready') onReady(d);
    else if (e.data.type === 'error') onError(d, e.data);
    else if (e.data.type === 'size') onSize(d, e.data);
  };
  diagrams.set(iframe, { onMsg, seen: iframe.isConnected });
  addEventListener('message', onMsg);
}

/** The frame has loaded: it gets Mermaid and the source to draw. */
function onReady({ iframe, src }) {
  libSource('mermaid').then(({ js }) => iframe.contentWindow?.postMessage({ __pbd: 1, type: 'render', src, label: 'Diagram', lib: js }, '*'));
}

/**
 * Mermaid couldn't draw it: the server hears, once, so the agent gets Mermaid's message and can fix the diagram. The
 * person sees the frame's own “couldn't be drawn” text and Show source either way.
 */
function onError({ iframe, box, src }, data) {
  // Reported already: only a reply's diagram is, so there's nothing more to say.
  if (data.render && iframe.dataset.failed) return;
  if (data.render && report(box, { src, error: { message: String(data.message ?? ''), line: data.line ?? null } })) {
    iframe.dataset.failed = '1';
    return;
  }
  console.error(`Diagram: ${data.message}`);
}

/** The frame measured its drawing: it takes that height, and a diagram too small to read is reported, once. */
function onSize({ iframe, box, src }, data) {
  iframe.style.height = `${Math.min(data.height, 900)}px`;
  iframe.dataset.sized = '1';
  if (typeof data.textPx === 'number') iframe.dataset.textPx = String(data.textPx);
  if (data.textPx < MIN_TEXT_PX && !iframe.dataset.reported && report(box, { src, textPx: data.textPx, width: data.width })) iframe.dataset.reported = '1';
}

/**
 * Tells the server about a diagram in a reply, for the agent that drew it. False when the diagram isn't in a reply (a
 * review's draft, the side panel), which has no agent to tell.
 * @param {Element} box @param {object} body
 */
function report(box, body) {
  const key = box.closest('[data-key]')?.getAttribute('data-key');
  const threadId = box.closest('[data-thread]')?.getAttribute('data-thread');
  if (!key || !threadId) return false;
  // Best effort: the person already sees the frame's own message, and the agent hears of a drawing problem only to
  // fix it, so a report that doesn't reach the server is dropped rather than shown.
  api(`/api/threads/${threadId}/items/${key}/diagram`, body).catch(() => {});
  return true;
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
      // KaTeX didn't load: each formula stays as its source, which still reads.
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
