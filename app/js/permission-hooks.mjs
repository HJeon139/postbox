// The permissions panel’s hooks section (#817). Postbox’s own settings turn off hooks from settings files and plugins,
// and the custom status line, in its turns in every mode but Run everything: a hook that approves a call would skip
// the ask rules for writes outside Postbox and the permission card. This section names each PreToolUse hook the
// server found in the settings files the agent reads (server/permission-hooks.mjs), and says what still runs. A hook’s
// matcher and command are the person’s data: they go in as text, through h().

import { h, icon } from './dom.mjs';

/**
 * What the section says about where the listed hooks run. On a host (#120), the list is this computer’s settings
 * files, and the host’s own aren’t read, so it doesn’t say these won’t run: it says where they’re from.
 * @param {{ handle: string, permissionMode: string, host?: string|null }} p
 */
function runsNote(p) {
  if (p.host) return `@${p.handle} runs on ${p.host}. These are the hooks in this computer’s settings files; the host’s own settings aren’t shown here.`;
  if (p.permissionMode === 'bypass') return `In Run everything mode, these run in @${p.handle}’s Postbox turns too.`;
  return `These don’t run in @${p.handle}’s Postbox turns, except in Run everything mode. They still run when you use Claude Code yourself.`;
}

/**
 * The line shown when no hook is listed: none when every file it reads failed (each says why), and “the other files”
 * when only some did.
 * @param {any[]} hooks  permissionsView’s
 */
function noneNote(hooks) {
  const failed = hooks.filter((f) => f.error).length;
  if (failed && failed === hooks.length) return null;
  if (failed) return h('span.help', {}, 'No PreToolUse hooks in the other settings files it reads.');
  return h('span.help', {}, 'No PreToolUse hooks in the settings files it reads.');
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
      'In every mode but Run everything, Postbox turns off hooks from settings files, plugin hooks and your custom status line for its own turns, since a hook that approves a tool call would skip the ask rules and the permission card. Hooks your organization manages still run, and one of those can still approve a call without asking you.',
    ),
  );
}
