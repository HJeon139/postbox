// The permissions panel’s hooks section (#817). Postbox’s own settings turn off hooks from settings files and plugins,
// and the custom status line, in its turns in Ask me and Accept edits: there a hook that approves a call would skip
// the ask rules for writes outside Postbox and the permission card. In Auto and Run everything they run (#806,
// shared/hook-modes.mjs). This section names each PreToolUse and
// PermissionRequest hook the server found in the settings files the agent reads, with its event (#871,
// server/permission-hooks.mjs), says plugins’ hooks can’t be listed, and says what still runs. A hook’s matcher and
// command are the person’s data: they go in as text, through h().

import { PERMISSIONS } from '/shared/agent-facts.mjs';
import { asksForWrites } from '/shared/hook-modes.mjs';
import { h, icon } from './dom.mjs';

/**
 * What the section says about where the listed hooks run. On a host (#120), the list is this computer’s settings
 * files, and the host’s own aren’t read, so it doesn’t say these won’t run: it says where they’re from.
 * @param {{ handle: string, permissionMode: string, host?: string|null }} p
 */
function runsNote(p) {
  if (p.host) return `${p.handle} runs on ${p.host}. These are the hooks in this computer’s settings files; the host’s own settings aren’t shown here.`;
  const name = (PERMISSIONS.find(([id]) => id === p.permissionMode) ?? PERMISSIONS[0])[1];
  if (asksForWrites(p.permissionMode))
    return `These don’t run in ${p.handle}’s Postbox turns in ${name} mode. They run in Auto and Run everything, and when you use Claude Code yourself.`;
  return `In ${name} mode, these run in ${p.handle}’s Postbox turns too. One that allows a call also skips your ask rules, this conversation’s included, as in your terminal.`;
}

/**
 * The line shown when no hook is listed: none when every file it reads failed (each says why), and “the other files”
 * when only some did.
 * @param {any[]} hooks  permissionsView’s
 */
function noneNote(hooks) {
  const failed = hooks.filter((f) => f.error).length;
  if (failed && failed === hooks.length) return null;
  if (failed) return h('span.help', {}, 'No PreToolUse or PermissionRequest hooks in the other settings files it reads.');
  return h('span.help', {}, 'No PreToolUse or PermissionRequest hooks in the settings files it reads.');
}

/**
 * The hooks section, from permissionsView’s hooks.
 * @param {{ persona: { handle: string, permissionMode: string, usesHostSetup: boolean, host?: string|null }, hooks: any[] }} view
 * @param {Record<string, string>} sources  the panel’s words for each settings source (“your user settings”)
 */
export function hooksSection({ persona: p, hooks }, sources) {
  const rows = hooks.flatMap((f) => [
    ...f.hooks.map((x) =>
      h(
        'li',
        {},
        h(
          'span.grow',
          {},
          h('span.small.dim', {}, `${x.event} `),
          h('code.perm-rule', {}, x.matcher),
          ' ',
          x.type === 'command' ? null : h('span.small.dim', {}, `${x.type} hook: `),
          h('code.perm-rule', {}, x.text),
          h('span.small.dim', {}, ` from ${sources[f.source] ?? f.source}`),
        ),
      ),
    ),
    f.more ? h('li', {}, h('span.small.dim', {}, `and ${f.more} more in ${f.file}`)) : null,
  ]);
  const errors = hooks.filter((f) => f.error).map((f) => h('p.err', {}, icon('warn'), f.error));
  const found = rows.some(Boolean);
  return h(
    'section.perm-sec',
    { id: 'perm-hooks' },
    h('h3.label', {}, 'Hooks before tool calls'),
    found ? h('ul.list-rows', {}, rows) : noneNote(hooks),
    found || p.host ? h('p.help', {}, runsNote(p)) : null,
    ...errors,
    p.usesHostSetup ? null : h('p.help', {}, 'It’s isolated, so it doesn’t read the hooks in your user settings.'),
    h(
      'p.help',
      {},
      'In Ask me and Accept edits, Postbox turns off hooks from settings files, plugin hooks and your custom status line for its own turns, since a hook that approves a tool call would skip the ask rules and the permission card. In Auto and Run everything they run, as when you use Claude Code yourself. Postbox can’t list your plugins’ hooks here: /hooks in Claude Code shows them. Hooks your organization manages always run, and one of those can approve a call without asking you.',
    ),
  );
}
