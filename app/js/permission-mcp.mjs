// The permissions panel’s MCP servers section (#66), moved out of openPermissions in app/js/permissions.mjs: the
// servers in the person’s Claude Code setup, each with a checkbox that turns it off for this persona.

import { api, client } from './client.mjs';
import { h, icon } from './dom.mjs';
import { MCP_SCOPE, MCP_STATUS } from './sheets.mjs';

/**
 * The section, from the servers the panel listed (null while it looks, { error } when it couldn’t).
 * @param {{ id: string, handle: string, usesHostSetup: boolean }} p  the persona
 * @param {any[] | { error: string } | null} mcp
 * @param {(fn: () => Promise<any>, done: string) => Promise<void>} change  the panel’s: runs a change, then reloads it
 */
export function mcpSection(p, mcp, change) {
  return h('section.perm-sec', { id: 'perm-mcp' }, h('h3.label', 'MCP servers'), servers(p, mcp, change));
}

/** What the section says: why there’s no list, or the servers with their checkboxes. */
function servers(p, mcp, change) {
  if (!p.usesHostSetup) return h('span.help', 'It’s isolated, so only Postbox’s own server loads.');
  if (mcp === null) return h('span.help', 'Looking for your MCP servers…');
  if (!Array.isArray(mcp)) return h('p.err', icon('warn'), `Couldn’t list your MCP servers: ${mcp.error}`);
  if (!mcp.length) return h('span.help', 'None found in your Claude Code setup. Postbox’s own server always loads.');
  const off = new Set(client.state.personas[p.id]?.mcpOff ?? []);
  return h(
    'ul.list-rows',
    mcp.map((m, i) =>
      h(
        'li',
        h(
          'span.check',
          {
            id: `perm-mcp-${i}`,
            role: 'checkbox',
            tabindex: '0',
            'aria-checked': String(!off.has(m.name)),
            'data-server': m.name,
            onclick: () => {
              const next = new Set(off);
              if (next.has(m.name)) next.delete(m.name);
              else next.add(m.name);
              void change(
                () => api(`/api/personas/${p.id}`, { mcpOff: [...next] }, 'PATCH'),
                `${m.name} is ${next.has(m.name) ? 'off' : 'on'} for @${p.handle} from its next turn.`,
              );
            },
            onkeydown: (e) => {
              if (e.key === ' ' || e.key === 'Enter') {
                e.preventDefault();
                e.currentTarget.click();
              }
            },
          },
          h('span.box'),
          h('span.mono', m.name),
        ),
        h('span.small.dim.grow', [MCP_STATUS[m.status] ?? m.status, MCP_SCOPE[m.scope]].filter(Boolean).join(' · ')),
      ),
    ),
  );
}
