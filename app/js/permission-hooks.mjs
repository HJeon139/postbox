// The permissions panel’s hooks section (#817). Postbox’s own settings turn off hooks from settings files and plugins,
// and the custom status line, in its turns in every mode but Run everything: a hook that approves a call would skip
// the ask rules for writes outside Postbox and the permission card. This section names each PreToolUse hook the
// server found in the settings files the agent reads (server/permission-hooks.mjs), and says what still runs. A hook’s
// matcher and command are the person’s data: they go in as text, through h().

import { h, icon } from './dom.mjs';

/**
 * The hooks section, from permissionsView’s hooks.
 * @param {{ persona: { handle: string, permissionMode: string, usesHostSetup: boolean }, hooks: any[] }} view
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
  const runs =
    p.permissionMode === 'bypass'
      ? `In Run everything mode, these run in @${p.handle}’s Postbox turns too.`
      : `These don’t run in @${p.handle}’s Postbox turns, except in Run everything mode. They still run when you use Claude Code yourself.`;
  return h(
    'section.perm-sec',
    { id: 'perm-hooks' },
    h('h3.label', {}, 'Hooks before tool calls'),
    found ? h('ul.list-rows', {}, rows) : h('span.help', {}, 'No PreToolUse hooks in the settings files it reads.'),
    found ? h('p.help', {}, runs) : null,
    ...errors,
    p.usesHostSetup ? null : h('p.help', {}, 'It’s isolated, so it doesn’t read the hooks in your user settings.'),
    h(
      'p.help',
      {},
      'In every mode but Run everything, Postbox turns off hooks from settings files, plugin hooks and your custom status line for its own turns, since a hook that approves a tool call would skip the ask rules and the permission card. Hooks your organization manages still run, and one of those can still approve a call without asking you.',
    ),
  );
}
