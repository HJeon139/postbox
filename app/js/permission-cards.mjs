// The cards Postbox draws for permissions, not catalog blocks: a call waiting for your answer, a call Claude Code
// refused, and an agent asking for a tool that’s turned off for it.

import { renderMarkdown } from '/shared/markdown.mjs';
import { api } from './client.mjs';
import { h, icon, trusted } from './dom.mjs';
import { focusComposer } from './hop-card.mjs';
import { toast } from './ui.mjs';

// An agent in “ask” mode waits here before a risky tool call. It isn’t a catalog block: Postbox draws it,
// and your answer goes straight back to the waiting tool call rather than to the agent as a message.
const PERMISSION_DONE = {
  allowed: 'Allowed',
  'allowed-always': 'Always allowed',
  'allowed-edited': 'Allowed with your edit',
  denied: 'Not allowed',
  expired: 'Expired: the turn ended before you answered',
};
/** What an answered card says. One left until Claude Code gave up on the call says how long it waited (#220). */
const doneText = (it) =>
  it.waitedMs ? `Expired: nobody answered within ${Math.round(it.waitedMs / 3600000)} hours` : (PERMISSION_DONE[it.status] ?? it.status);
/**
 * The answers (#66, #10): Allow; Always allow, with the rule and where it’s saved shown in words first; Edit, which
 * changes the command (or the input’s JSON) and allows that; Don’t allow, with an optional reason the agent reads.
 */
export function permissionBlock(it, ctx) {
  const open = it.status === 'open';
  const act = (action, values = {}) =>
    api(`/api/threads/${ctx.threadId}/items/${it.id}/act`, { action, values })
      .then(focusComposer)
      .catch((e) => {
        toast({ title: 'That didn’t go through', text: e.message, level: 'blocking' });
        throw e;
      });
  const titleId = `pm-${it.id}`;
  const by = it.who ? `@${it.handle}’s subagent (${it.who})` : `@${it.handle}`;
  const bash = it.tool === 'Bash';
  // Edit and Don’t allow open a small form in the card; only one at a time.
  const form = h('div.perm-form');
  const foot = h('div.block-foot');
  const buttons = () => [
    h('button.btn', { type: 'button', onclick: () => act('allow') }, 'Allow'),
    it.always ? h('button.btn', { type: 'button', 'aria-describedby': `${titleId}-always`, onclick: () => act('always') }, 'Always allow') : null,
    // Edit needs the call’s whole input: one too large to keep here can only be allowed as it is.
    it.input ? h('button.btn', { type: 'button', 'aria-expanded': 'false', onclick: (e) => showEdit(e.currentTarget) }, 'Edit…') : null,
    h('button.btn', { type: 'button', 'aria-expanded': 'false', onclick: (e) => showDeny(e.currentTarget) }, 'Don’t allow…'),
    h('span.small.dim', `${by} is waiting for you.`),
  ];
  const close = (back) => {
    form.replaceChildren();
    for (const b of foot.querySelectorAll('[aria-expanded]')) b.setAttribute('aria-expanded', 'false');
    back?.focus();
  };
  function showEdit(button) {
    close();
    button.setAttribute('aria-expanded', 'true');
    const start = bash ? String(it.input.command ?? '') : JSON.stringify(it.input, null, 2);
    const id = `${titleId}-edit`;
    const err = h('p.err', { id: `${id}-err`, hidden: true });
    const box = h(
      `textarea.textarea.mono`,
      { id, rows: String(Math.min(12, start.split('\n').length + 1)), spellcheck: 'false', 'aria-describedby': `${id}-err` },
      start,
    );
    const submit = () => {
      let values;
      if (bash) values = { command: box.value };
      else {
        // Checked here first, so a typo is caught before it reaches the agent; the server checks it again.
        try {
          const v = JSON.parse(box.value);
          if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('It has to be a JSON object, like the one it started from.');
        } catch (e) {
          err.hidden = false;
          err.textContent = `This doesn’t parse: ${e.message}`;
          box.classList.add('invalid');
          box.focus();
          return;
        }
        values = { input: box.value };
      }
      act('edit', values).catch(() => box.focus());
    };
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close(button);
      }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        submit();
      }
    });
    form.replaceChildren(
      h('label.label', { for: id }, bash ? 'The command to run instead' : 'The input to use instead (JSON)'),
      box,
      err,
      h(
        'div.row-flex',
        h('button.btn.send', { type: 'button', onclick: submit }, 'Allow with this edit'),
        h('button.btn.ghost', { type: 'button', onclick: () => close(button) }, 'Cancel'),
      ),
    );
    box.focus();
  }
  function showDeny(button) {
    close();
    button.setAttribute('aria-expanded', 'true');
    const id = `${titleId}-why`;
    const why = h('input.input', { id, placeholder: 'Optional: what to do instead', maxlength: '1000' });
    const submit = () => act('deny', { reason: why.value }).catch(() => why.focus());
    why.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submit();
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        close(button);
      }
    });
    form.replaceChildren(
      h('label.label', { for: id }, `Why not? @${it.handle} reads this`),
      why,
      h(
        'div.row-flex',
        h('button.btn.send', { type: 'button', onclick: submit }, 'Don’t allow'),
        h('button.btn.ghost', { type: 'button', onclick: () => close(button) }, 'Cancel'),
      ),
    );
    why.focus();
  }
  if (open) foot.append(...buttons().filter(Boolean));
  const done = it.status.startsWith('allowed');
  return h(
    'div.col.block',
    { role: 'group', 'aria-labelledby': titleId, class: open ? '' : 'answered', style: open ? { borderColor: 'var(--accent)' } : {} },
    h(
      'div.block-head',
      open ? h('span.g.g-needs', { 'aria-hidden': 'true' }) : null,
      h('span.title.grow', { id: titleId }, `Let ${by} ${it.summary}?`),
      h('span.kind', 'Permission · ', h('span.tool-name', it.tool)),
    ),
    h(
      'div.block-body',
      // A write outside Postbox (#112): say so, and show its draft as it will read, before anything exists outside.
      it.outside
        ? h(
            'p.small',
            h('b', 'This writes outside Postbox'),
            it.where ? [', to ', h('b', it.where.server), it.where.target ? ` (${it.where.target.what} “${it.where.target.name}”)` : ''] : '',
            '.',
            open ? ' Nothing is created, sent or changed until you allow it.' : '',
          )
        : null,
      it.draft
        ? h(
            'div.col.perm-draft',
            { role: 'group', 'aria-label': 'The draft', tabindex: '0' },
            h('span.label', `The draft, from ${it.draft.field}`),
            h('div.md', { html: trusted(renderMarkdown(it.draft.text)) }),
          )
        : null,
      // The whole command, wrapped: you decide on what you can see.
      it.detail ? h('pre.md-code.perm-detail', h('code', it.detail)) : null,
      // What Always allow saves, in words, before you click it.
      open && it.always
        ? h(
            'div.small.perm-always',
            { id: `${titleId}-always` },
            it.always.lines.map((l) => h('p', l.rule ? ['Always allow ', h('code', l.rule), l.text.slice(`Always allow ${l.rule}`.length)] : l.text)),
            it.always.moved ? h('p.dim', it.always.moved) : null,
            // What Always allow gives up on a write outside Postbox (#112): the draft step, for that tool.
            it.outside ? h('p', `From now on ${by} can use `, h('code', it.tool), ' without showing you a draft.') : null,
          )
        : null,
      open ? form : null,
      !open
        ? h(
            'span.answered-note',
            icon(done ? 'check' : 'x', 'i-sm'),
            doneText(it),
            it.status === 'allowed-always' && it.always ? ` (${it.always.lines.map((l) => l.rule ?? l.text).join(', ')})` : '',
          )
        : null,
      !open && it.edited ? h('pre.md-code.perm-detail', { 'aria-label': 'What ran instead' }, h('code', it.edited)) : null,
      !open && it.reason ? h('p.small', h('b', 'Your reason: '), it.reason) : null,
    ),
    open ? foot : null,
  );
}

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
export function denialBlock(it, ctx) {
  const open = it.status === 'open';
  const act = (action) =>
    api(`/api/threads/${ctx.threadId}/items/${it.id}/act`, { action })
      .then(focusComposer)
      .catch((e) => toast({ title: 'That didn’t go through', text: e.message, level: 'blocking' }));
  const titleId = `dn-${it.id}`;
  const by = it.who ? `@${it.handle}’s subagent (${it.who})` : `@${it.handle}`;
  // A chained command gets no rule (server/permission-rules.mjs, chains): one for the whole line would never match (#238).
  const chained = !it.rules.once;
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
      open && chained
        ? h(
            'p.small',
            `Claude Code checks each part of a chained command (joined by &&, ||, ;, | or &, or inside $( )) against its rules on its own, so no one rule can allow this whole line, and there’s nothing to allow once or always. To let it run, leave it and ask ${by} to run the parts as separate commands: a part that’s refused again gets a card of its own.`,
          )
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

// An agent asks for a tool the person turned off for it (#104). The card says what turning it on does before the click:
// it changes the persona, in every conversation, and the permission mode still decides each call.
export function toolAskBlock(it, ctx) {
  const open = it.status === 'open';
  const act = (action) =>
    api(`/api/threads/${ctx.threadId}/items/${it.id}/act`, { action })
      .then(focusComposer)
      .catch((e) => toast({ title: 'That didn’t go through', text: e.message, level: 'blocking' }));
  const titleId = `ta-${it.id}`;
  return h(
    'div.col.block',
    { role: 'group', 'aria-labelledby': titleId, class: open ? '' : 'answered', style: open ? { borderColor: 'var(--accent)' } : {} },
    h(
      'div.block-head',
      open ? h('span.g.g-needs', { 'aria-hidden': 'true' }) : null,
      h('span.title.grow', { id: titleId }, `@${it.handle} asks you to turn on “${it.label}”`),
      // Turned on from the card, the agent panel or the persona sheet (#237): the card says what’s true now.
      h('span.kind', it.status === 'on' ? 'Turned on · ' : 'Turned off · ', h('span.tool-name', it.tool)),
    ),
    h(
      'div.block-body',
      h('p', it.status === 'on' ? `It was turned off for @${it.handle} in Postbox.` : `It’s turned off for @${it.handle} in Postbox, so it can’t use it here.`),
      it.why ? h('p.small', h('b', `@${it.handle}: `), it.why) : null,
      open
        ? h(
            'p.small.dim',
            `Turning it on ticks it in @${it.handle}’s Tools, in every conversation, from its next turn. Its permission mode still decides each call.`,
          )
        : h('span.answered-note', icon(it.status === 'on' ? 'check' : 'x', 'i-sm'), it.status === 'on' ? 'Turned on.' : 'Kept off.'),
    ),
    open
      ? h(
          'div.block-foot',
          h('button.btn', { type: 'button', onclick: () => act('on') }, `Turn on for @${it.handle}`),
          h('button.btn.ghost', { type: 'button', onclick: () => act('off') }, 'Keep it off'),
        )
      : null,
  );
}
