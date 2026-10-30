// The line a call leaves when the person’s request covered it, so it ran without a card (server/write-intent.mjs,
// #296): what ran, and the words of theirs that asked for it. Stop ends that request: the agent’s next call asks again.

import { api } from './client.mjs';
import { h, icon } from './dom.mjs';
import { toast } from './ui.mjs';

/** A command’s first line, short enough for one line of the conversation; another tool by its name. */
const what = (it) => {
  const first = String(it.tool === 'Bash' ? it.detail : it.tool).split('\n')[0];
  return first.length > 80 ? `${first.slice(0, 79)}…` : first;
};

/** @param {any} it  the allowedcall item @param {{ threadId: string }} ctx */
export function allowedCallLine(it, ctx) {
  const stopped = it.status === 'stopped';
  const stop = () =>
    api(`/api/threads/${ctx.threadId}/items/${it.id}/act`, { action: 'stop' }).catch((e) =>
      toast({ title: 'That didn’t go through', text: e.message, level: 'blocking' }),
    );
  const why = it.approved ? `you ${it.approved.verb} “${it.approved.label}”` : `you asked: “${it.quote}”`;
  return h(
    'div.col.sys-line',
    { dataset: { allowedCall: it.id } },
    icon('check', 'i-sm'),
    h('span.grow', 'Ran ', h('code', what(it)), ` for @${it.handle} without a card: ${why}`, stopped ? ' · Stopped' : ''),
    stopped ? null : h('button.btn.sm.ghost', { type: 'button', onclick: stop }, 'Stop these calls'),
  );
}
