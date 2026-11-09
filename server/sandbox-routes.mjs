// The routes of the sandbox pages (server/sandbox.mjs): an agent app’s version, and the Mermaid page. Each is its own
// page with a strict policy and, because that policy starts with `sandbox` and has no allow-same-origin, an opaque
// origin.

import { httpError } from './helpers.mjs';
import { mermaidPage, sandboxPage } from './sandbox.mjs';
import { decodePath, TYPES } from './served-files.mjs';

/**
 * The sandbox page a request’s path asks for, with the headers it’s sent with, or null for any other path.
 * @param {{ state: { apps: Record<string, any> } }} store @param {string} origin  the listener’s
 * @param {string} path @param {URL} url
 * @returns {{ html: string, headers: Record<string, string> } | null}
 */
export function sandboxRoute(store, origin, path, url) {
  if (!path.startsWith('/sandbox/')) return null;
  const theme = url.searchParams.get('theme') === 'light' ? 'light' : 'dark';
  const m = path.match(/^\/sandbox\/app\/([^/]+)\/(\d+)$/);
  if (m) {
    const app = store.state.apps[decodePath(m[1])];
    const v = app?.versions[+m[2] - 1];
    if (!v) throw httpError(404, 'That app version doesn’t exist.');
    const page = sandboxPage({ origin, app, version: v, theme, check: url.searchParams.has('check') });
    return {
      html: page.html,
      headers: { 'content-type': TYPES['.html'], 'content-security-policy': page.csp, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
    };
  }
  if (path === '/sandbox/mermaid') {
    const page = mermaidPage({ origin, theme });
    return { html: page.html, headers: { 'content-type': TYPES['.html'], 'content-security-policy': page.csp, 'cache-control': 'no-store' } };
  }
  return null;
}
