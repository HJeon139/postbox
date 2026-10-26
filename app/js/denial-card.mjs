// A refusal card (server/permission-cards.mjs, recordDenial): a call Claude Code refused without asking, which the
// person can allow once, always, or leave. Moved out of app/js/permission-cards.mjs, which re-exports it.

import { api } from './client.mjs';
import { h, icon } from './dom.mjs';
import { focusComposer } from './hop-card.mjs';
import { toast } from './ui.mjs';

// Claude Code refused a call without asking you (auto mode’s check, a rule, or the mode). Unlike a permission
// card nothing is waiting: Allow once or Always allow tells the agent to try again.
const DENIAL_DONE = {
  'allowed-once': 'Allowed once. The agent is trying again.',
  'allowed-always': 'Always allowed. The agent is trying again.',
  left: 'Left refused.',
};
const DENIAL_WHY = {
  classifier: 'auto mode’s safety check',
  rule: 'a permission rule',
  subcommandResults: 'a permission rule',
  mode: 'the permission mode',
  asyncAgent: 'a background subagent can’t ask you',
};
/** Why a host turn’s refusal has no Always allow: Postbox can’t save a rule where its Claude Code reads it (server/permission-cards.mjs, hostAlways). @param {string} by */
/** Why a refusal has no rule to allow once or always (server/permission-rules.mjs, rulesFor): a * or a chain. */
const noRuleNote = (why, by) =>
  why === 'wildcard'
    ? `Claude Code reads * in a rule as a wildcard, so a rule for this command would also allow commands you haven’t seen, and there’s nothing to allow once or always. To let it run, leave it and ask ${by} to name the files instead of using *.`
    : why === 'paren'
      ? `Claude Code would read a ) in this command as the end of its rule, so a rule for it could also allow commands you haven’t seen, and there’s nothing to allow once or always. To let it run, leave it and ask ${by} to run it without the unmatched ).`
      : `Claude Code checks each part of a chained command (joined by &&, ||, ;, | or &) against its rules on its own, so no one rule can allow this whole line, and there’s nothing to allow once or always. To let it run, leave it and ask ${by} to run the parts as separate commands: a part that’s refused again gets a card of its own.`;
const onHostNote = (by) =>
  `${by} runs on a host, and Postbox can’t save a rule there, so there’s no Always allow. Allow it once and retry, or add the rule to the agent folder’s .claude/settings.local.json on the host.`;
export function denialBlock(it, ctx) {
  const open = it.status === 'open';
  const act = (action) =>
    api(`/api/threads/${ctx.threadId}/items/${it.id}/act`, { action })
      .then(focusComposer)
      .catch((e) => toast({ title: 'That didn’t go through', text: e.message, level: 'blocking' }));
  const titleId = `dn-${it.id}`;
  const by = it.who ? `@${it.handle}’s subagent (${it.who})` : `@${it.handle}`;
  // A chained command gets no rule: one for the whole line would never match (#238). Nor does one with a *, which a
  // rule reads as a wildcard (#281). server/permission-rules.mjs, rulesFor, says which in why.
  const noRule = !it.rules.once;
  return h(
    'div.col.block',
    { role: 'group', 'aria-labelledby': titleId, class: open ? '' : 'answered', style: open ? { borderColor: 'var(--accent)' } : {} },
    h(
      'div.block-head',
      open ? h('span.g.g-needs', { 'aria-hidden': 'true' }) : null,
      h('span.title.grow', { id: titleId }, `Refused: ${by} tried to ${it.summary.charAt(0).toLowerCase()}${it.summary.slice(1)}`),
      h('span.kind', 'Refused · ', h('span.tool-name', it.tool)),
    ),
    h(
      'div.block-body',
      it.detail ? h('pre.md-code.perm-detail', h('code', it.detail)) : null,
      it.reason || DENIAL_WHY[it.reasonType]
        ? h('p.small', h('b', 'Why: '), it.reason || '', DENIAL_WHY[it.reasonType] ? ` (${DENIAL_WHY[it.reasonType]})` : '')
        : null,
      open && noRule
        ? h('p.small', noRuleNote(it.rules.why, by))
        : open && it.remote
          ? h('p.small.dim', onHostNote(by))
          : open
            ? h(
                'p.small.dim',
                'Always allow adds ',
                h('code', it.rules.always),
                ' to .claude/settings.local.json in the agent’s folder, so your terminal sessions follow it too. A deny rule in your Claude Code settings still wins.',
              )
            : h('span.answered-note', icon(it.status === 'left' ? 'x' : 'check', 'i-sm'), DENIAL_DONE[it.status] ?? it.status),
    ),
    open
      ? h(
          'div.block-foot',
          it.rules.once ? h('button.btn', { type: 'button', onclick: () => act('once') }, 'Allow once and retry') : null,
          it.rules.always ? h('button.btn', { type: 'button', onclick: () => act('always') }, `Always allow ${it.rules.alwaysWords}`) : null,
          h('button.btn.ghost', { type: 'button', onclick: () => act('leave') }, 'Leave it'),
        )
      : null,
  );
}
