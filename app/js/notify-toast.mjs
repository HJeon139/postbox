// A blocking event from an agent: said aloud when its conversation is in view, else a toast that goes there.

import { client, hrefOf } from './client.mjs';
import { ringFor } from './ring.mjs';
import { navigate, route, say, toast } from './ui.mjs';

/** @param {any} d */
export function notify(d) {
  if (d.level !== 'blocking') return; // informational events are still badges, not toasts
  // In view: its conversation, or the side thread it’s in, open in the panel (#121).
  const r = route();
  if ((r.threadId === d.threadId || r.sideId === d.threadId) && document.visibilityState === 'visible') {
    say(`${d.title}. ${d.text}`);
    return;
  }
  const se = client.state.sessions[d.sessionId];
  toast({
    title: d.title,
    text: d.text,
    level: 'blocking',
    ring: se ? ringFor(se, 'sm') : null,
    action: { label: 'Go', run: () => navigate(hrefOf(d.threadId)) },
    timeout: 12000,
  });
}
