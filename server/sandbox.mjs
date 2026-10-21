// Sandbox pages for agent-written apps and Mermaid diagrams.
//
// Each page is loaded in an <iframe sandbox="allow-scripts"> (no allow-same-origin), so it runs in an
// opaque origin: it can’t read Postbox’s storage, cookies or DOM. Its content-security policy allows
// inline script and style (the agent’s code), the kit and vendored libraries from /kit/, images from
// /media/ or data: URLs, and nothing else — no fetch, no websockets, no forms, no nested frames.
// The only way out is postMessage to Postbox, which handles it through the bridge.

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function csp(origin) {
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' ${origin}/kit/`,
    `style-src 'unsafe-inline' ${origin}/kit/`,
    `img-src data: ${origin}/media/`,
    `font-src ${origin}/kit/`,
    "connect-src 'none'", "frame-src 'none'", "worker-src 'none'", "form-action 'none'", "base-uri 'none'",
  ].join('; ');
}

/** The page for one version of an agent-written app. */
export function sandboxPage({ origin, app, version, theme, check }) {
  const init = { appId: app.id, version: version.v, title: app.title, check: !!check };
  const html = `<!doctype html>
<html lang="en" data-theme="${theme}" class="stage pb-sandbox">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(app.title)}</title>
<link rel="stylesheet" href="${origin}/kit/workbench.css">
<script src="${origin}/kit/kit.js" data-init="${esc(JSON.stringify(init))}"></script>
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
<link rel="stylesheet" href="${origin}/kit/workbench.css">
<style>body { background: var(--sunk); margin: 0; padding: 12px; } #out svg { max-width: 100%; height: auto; display: block; margin: 0 auto; } .err { color: var(--alert-ink); font-size: 12px; }</style>
<script src="${origin}/kit/vendor/mermaid/mermaid.min.js"></script>
</head>
<body><div id="out" role="img" aria-label="Diagram"></div>
<script src="${origin}/kit/diagram.js"></script>
</body>
</html>`;
  return { html, csp: csp(origin) };
}
