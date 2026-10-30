// The line a write outside Postbox leaves when the block that started the turn approved it, so it ran without a card
// (server/write-intent.mjs, #296). Stop ends that approval: the agent’s next write asks again.

import { api } from './client.mjs';
import { h, icon } from './dom.mjs';
import { toast } from './ui.mjs';

/** @param {any} it  the allowedwrite item @param {{ threadId: string }} ctx */
export function allowedWriteLine(it, ctx) {
  const stopped = it.status === 'stopped';
  const stop = () =>
    api(`/api/threads/${ctx.threadId}/items/${it.id}/act`, { action: 'stop' }).catch((e) =>
      toast({ title: 'That didn’t go through', text: e.message, level: 'blocking' }),
    );
  return h(
    'div.col.sys-line',
    { dataset: { allowedWrite: it.id } },
    icon('check', 'i-sm'),
    h('span.grow', 'Ran ', h('code', it.what), ` for @${it.handle} without asking: you ${it.verb} “${it.approved}”`, stopped ? ' · Stopped' : ''),
    stopped ? null : h('button.btn.sm.ghost', { type: 'button', onclick: stop }, 'Stop these writes'),
  );
}
