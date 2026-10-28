// A scheduled wake’s transcript line, kept outside thread.mjs at its size ceiling.

import { api } from './client.mjs';
import { h, icon, timeOf } from './dom.mjs';
import { toast } from './ui.mjs';

/** @param {any} item */
export function scheduledWakeLine(item) {
  return h(
    'div.col.sys-line',
    icon('clock', 'i-sm'),
    h('b', `@${item.handle}`),
    item.status === 'pending'
      ? ` will wake itself at ${timeOf(item.at)}`
      : item.status === 'canceled'
        ? ' won’t wake itself (canceled)'
        : ` woke itself at ${timeOf(item.at)}`,
    item.note ? ` · “${item.note}”` : '',
    item.status === 'pending'
      ? [
          ' · ',
          h(
            'button.btn.sm.ghost',
            {
              type: 'button',
              onclick: () => api(`/api/schedules/${item.scheduleId}/cancel`, {}).catch((e) => toast({ title: 'Couldn’t cancel', text: e.message })),
            },
            'Cancel',
          ),
        ]
      : null,
  );
}
