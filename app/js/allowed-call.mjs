// The line a write leaves when the person’s request covered it, so it ran without a card (server/write-intent.mjs,
// #296): what ran, in full, and why: the confirm they confirmed, or the words they typed. Stop ends that request: the
// agent’s next call asks again.

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
  return h(
    'div.col',
    { dataset: { allowedCall: it.id } },
    h(
      'div.sys-line',
      icon('check', 'i-sm'),
      h('span.grow', 'Ran ', h('code', first(it)), ` for @${it.handle} without a card: ${why}`, stopped ? ' · Stopped' : ''),
      stopped ? null : h('button.btn.sm.ghost', { type: 'button', onclick: stop }, 'Stop these calls'),
    ),
    // The whole call, as it ran.
    h('details.small', h('summary', 'The whole call'), h('pre.mono', it.detail)),
  );
}
