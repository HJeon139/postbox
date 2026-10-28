// Sandbox pages for agent-written apps and Mermaid diagrams.
//
// Each page is served with the policy `sandbox allow-scripts` (no allow-same-origin), so it runs in an
// opaque origin: it can’t read Postbox’s storage, cookies or DOM. Its content-security policy allows
// inline script and style (the agent’s code), the kit and vendored libraries from /kit/, images from
// /media/ or data: URLs, and nothing else — no fetch, no websockets, no forms, no nested frames.
// The only way out is postMessage to Postbox, which handles it through the bridge.

import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { LIMITS } from '../shared/limits.mjs';

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

// The kit, its stylesheet and the diagram script are inlined into each page (and the check into a check frame’s), so a sandboxed page loads no
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
const syntaxCache = new WeakMap();
const tagBoundary = (char) => !char || char === '>' || char === '/' || /\s/.test(char);
const findTag = (text, tag, from) => {
  for (let i = from; i <= text.length - tag.length; i++) if (text.slice(i, i + tag.length).toLowerCase() === tag) return i;
  return -1;
};

/** The closing angle bracket of an HTML tag, ignoring one inside a quoted attribute. */
function tagEnd(text, from) {
  let quote = '';
  for (let i = from; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (char === quote) quote = '';
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '>') return i;
  }
  return -1;
}

/** Inline script attributes and bodies, following script raw-text end tags without treating the regexp as an HTML parser. */
function inlineScripts(code) {
  const text = String(code);
  const scripts = [];
  let from = 0;
  while (from < text.length) {
    const open = findTag(text, '<script', from);
    if (open < 0) break;
    const nameEnd = open + '<script'.length;
    if (!tagBoundary(text[nameEnd])) {
      from = nameEnd;
      continue;
    }
    const openEnd = tagEnd(text, nameEnd);
    if (openEnd < 0) break;
    let close = findTag(text, '</script', openEnd + 1);
    while (close >= 0 && !tagBoundary(text[close + '</script'.length])) close = findTag(text, '</script', close + 2);
    if (close < 0) break;
    const closeEnd = tagEnd(text, close + '</script'.length);
    if (closeEnd < 0) break;
    scripts.push({ attributes: text.slice(nameEnd, openEnd), body: text.slice(openEnd + 1, close) });
    from = closeEnd + 1;
  }
  return scripts;
}

/** Syntax errors in an app’s inline JavaScript, with the script and source position. */
export function scriptSyntaxErrors(code) {
  const errors = [];
  let script = 0;
  for (const { attributes, body } of inlineScripts(code)) {
    script++;
    const type = attributes.match(/\btype\s*=\s*["']([^"']+)["']/i)?.[1]?.toLowerCase();
    if (type && !['text/javascript', 'application/javascript'].includes(type)) continue;
    // App code is capped at 600,000 characters and parsed once per cached version, so this synchronous pass stays
    // bounded while recovering diagnostics the sandboxed browser hides (#328).
    try {
      new vm.Script(body, { filename: `app-script-${script}.js` });
    } catch (error) {
      const lines = String(error.stack ?? '').split('\n');
      const line = Number(lines[0]?.match(/:(\d+)$/)?.[1]) || 1;
      const column = Math.max(1, (lines[2]?.indexOf('^') ?? 0) + 1);
      errors.push(`${error.name}: ${error.message} (script ${script}, line ${line}, column ${column})`);
    }
  }
  return errors;
}

function versionSyntaxErrors(version) {
  if (!syntaxCache.has(version)) syntaxCache.set(version, scriptSyntaxErrors(version.code));
  return syntaxCache.get(version);
}

/** The page for one version of an agent-written app. */
export function sandboxPage({ origin, app, version, theme, check }) {
  // The kit can’t import /shared/ (the page loads no files), so the limits it enforces come with the page.
  const init = {
    appId: app.id,
    version: version.v,
    title: app.title,
    check: !!check,
    limits: { eventBytes: LIMITS.eventBytes },
    syntaxErrors: versionSyntaxErrors(version),
  };
  const html = `<!doctype html>
<html lang="en" data-theme="${theme}" class="stage pb-sandbox">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(app.title)}</title>
${css()}
<script data-init="${esc(JSON.stringify(init))}">${inline('kit/kit.js', '</script')}</script>
${check ? `<script>${inline('kit/check-layout.js', '</script')}</script>\n<script>${inline('kit/check-controls.js', '</script')}</script>\n<script>${inline('kit/check.js', '</script')}</script>\n` : ''}</head>
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
