// The line a write leaves when the person’s request covered it, so it ran without a card (server/write-intent.mjs,
// #296): what ran, in full, and why: the confirm they confirmed, or the words they typed. For a push, Postbox made it
// itself, and the line says what landed where, or why it couldn’t. Stop ends that request: the agent’s next call asks
// again.

import { api } from './client.mjs';
import { h, icon } from './dom.mjs';
import { toast } from './ui.mjs';

/** A command’s first line, short enough for one line of the conversation; another tool by its name. */
const first = (it) => {
  const line = String(it.tool === 'Bash' ? it.detail : it.tool).split('\n')[0];
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
};

/** @param {any} it  the allowedcall item @param {{ threadId: string }} ctx */
export function allowedCallLine(it, ctx) {
  const stopped = it.status === 'stopped';
  const stop = () =>
    api(`/api/threads/${ctx.threadId}/items/${it.id}/act`, { action: 'stop' }).catch((e) =>
      toast({ title: 'That didn’t go through', text: e.message, level: 'blocking' }),
    );
  const why = it.how === 'confirmed' ? `you confirmed “${it.approved}”` : `you asked: “${it.quote}”`;
  // A push Postbox made itself, in place of the agent’s (server/push-on-request.mjs): what landed where, or why not.
  const p = it.push;
  const said = !p
    ? ['Ran ', h('code', first(it)), ` for @${it.handle} without a card: ${why}`]
    : it.status === 'failed'
      ? ['Couldn’t push ', h('code', p.sha.slice(0, 7)), ` to ${p.branch} of ${p.url} for @${it.handle}: ${p.error}. It asks you on a card instead`]
      : ['Pushed ', h('code', p.sha.slice(0, 7)), ` to ${p.branch} of ${p.url} for @${it.handle}, in place of its own git push: ${why}`];
  return h(
    'div.col',
    { dataset: { allowedCall: it.id } },
    h(
      'div.sys-line',
      icon(it.status === 'failed' ? 'warn' : 'check', 'i-sm'),
      h('span.grow', ...said, stopped ? ' · Stopped' : ''),
      stopped || it.status === 'failed' ? null : h('button.btn.sm.ghost', { type: 'button', onclick: stop }, 'Stop these calls'),
    ),
    // The whole call, as it ran.
    h('details.small', h('summary', 'The whole call'), h('pre.mono', it.detail)),
  );
}
