// Sandbox pages for agent-written apps and Mermaid diagrams.
//
// Each page is served with the policy `sandbox allow-scripts` (no allow-same-origin), so it runs in an
// opaque origin: it can’t read Postbox’s storage, cookies or DOM. Its content-security policy allows
// inline script and style (the agent’s code), the kit and vendored libraries from /kit/, images from
// /media/ or data: URLs, and nothing else — no fetch, no websockets, no forms, no nested frames.
// The only way out is postMessage to Postbox, which handles it through the bridge.

import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * The policy for every sandbox page. Its first directive does what an iframe’s sandbox attribute does: the page
 * gets an opaque origin and may run scripts, nothing more. It’s sent by the server rather than set on the iframe
 * because some embedded browsers (the Claude desktop app’s browser pane) refuse to load frames that carry the
 * attribute. The host’s bridge only answers frames whose origin is opaque, so a page without it never runs.
 */
export function csp(origin) {
  return [
    'sandbox allow-scripts',
    "default-src 'none'",
    // Everything the page runs is inline: the agent’s code, the kit, and libraries sent over the bridge.
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    `img-src data: ${origin}/media/`,
    // Narration arrives as audio data over the bridge and plays from a blob: URL.
    'media-src blob:',
    // KaTeX’s fonts arrive inside its stylesheet as data: URLs.
    'font-src data:',
    "connect-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ');
}

// The kit, its stylesheet and the diagram script are inlined into each page, so a sandboxed page loads no
// files: some browsers (the Claude desktop app’s browser pane) block every request from an opaque origin.
const files = new Map();
function inline(rel, closer) {
  const path = fileURLToPath(new URL(`../app/${rel}`, import.meta.url));
  const mtime = statSync(path).mtimeMs;
  const hit = files.get(rel);
  if (hit?.mtime === mtime) return hit.text;
  // A closing tag inside the text would end the element early.
  const text = readFileSync(path, 'utf8').replaceAll(closer, closer.replace('/', '\\/'));
  files.set(rel, { mtime, text });
  return text;
}
const css = () => `<style>${inline('workbench.css', '</style')}</style>`;

/** The page for one version of an agent-written app. */
export function sandboxPage({ origin, app, version, theme, check }) {
  const init = { appId: app.id, version: version.v, title: app.title, check: !!check };
  const html = `<!doctype html>
<html lang="en" data-theme="${theme}" class="stage pb-sandbox">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(app.title)}</title>
${css()}
<script data-init="${esc(JSON.stringify(init))}">${inline('kit/kit.js', '</script')}</script>
</head>
<body>
${version.code}
</body>
</html>`;
  return { html, csp: csp(origin) };
}

/** A page that renders one Mermaid diagram, sent to it by postMessage. */
export function mermaidPage({ origin, theme }) {
  const html = `<!doctype html>
<html lang="en" data-theme="${theme}" class="pb-sandbox pb-diagram">
<head>
<meta charset="utf-8">
${css()}
<style>body { background: var(--sunk); margin: 0; padding: 12px; } #out svg { max-width: 100%; height: auto; display: block; margin: 0 auto; } .err { color: var(--alert-ink); font-size: 12px; }</style>
</head>
<body><div id="out" role="img" aria-label="Diagram"></div>
<script>${inline('kit/diagram.js', '</script')}</script>
</body>
</html>`;
  return { html, csp: csp(origin) };
}
