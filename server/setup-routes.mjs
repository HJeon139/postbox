// What a persona would load, for the persona sheet: the routes server/index.mjs’s route() calls in one line. Reads
// only, so none needs the page’s token.

import { mcpServerList, yourMcpServers } from './adapters/mcp-config.mjs';

const done = (status, body) => ({ status, body });

/**
 * The route for one request, or null when it isn’t one of these.
 * @param {any} rt @param {string} path @param {string} method @param {URL} url
 * @param {string} claudeHome  where the person’s Claude Code config is read (the home folder; tests use a temp one)
 */
export async function setupRoute(rt, path, method, url, claudeHome) {
  if (method !== 'GET') return null;
  // The MCP servers a persona would load, with their status (#59): names, scopes and statuses only, never config.
  if (path === '/api/mcp-servers') {
    const { persona, folder, seen } = rt.mcpContext(url.searchParams.get('personaId'), url.searchParams.get('projectId'));
    const found = await yourMcpServers(folder, { home: claudeHome });
    return done(200, { folder, servers: mcpServerList({ found, seen, off: persona?.mcpOff ?? [] }) });
  }
  return null;
}
