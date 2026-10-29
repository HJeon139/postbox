// What the hostwakes tests share (tests/uat-hostwakes*.test.mjs): facts shaped as a host-mode run records them. The
// wake_agent results are the texts Postbox gives: on a host, the shim’s answer as an agent on a host got it on 26 October
// 2026 (“Sent your message for … to Postbox. Postbox applies it as soon as it’s connected to this host.”); here, the
// refusal of a wake while a card waits (server/side-threads.mjs). Moved from tests/uat-hostwakes.test.mjs.

import { HOSTWAKE_CHECKS } from '../tools/uat/triggers-hostwakes.mjs';

export const SENT = 'Sent your message for researcher to Postbox. Postbox applies it as soon as it’s connected to this host.';
export const REFUSED = 'Your message to @critic wasn’t sent: another request is waiting for the person to answer it. Send it again once they have.';
export const T0 = Date.parse('2026-10-26T10:00:00Z');
export const s = (n) => T0 + n * 1000;

/** A wake_agent call in a stream, with its result. */
export const wakeStream = (handle, at, to, result, message = `${handle} to ${to}`) => ({
  handle,
  events: [
    {
      type: 'assistant',
      timestamp: new Date(at).toISOString(),
      message: { content: [{ type: 'tool_use', id: `tu-${handle}-${at}`, name: 'mcp__postbox__wake_agent', input: { handle: to, message } }] },
    },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `tu-${handle}-${at}`, content: [{ type: 'text', text: result }] }] } },
  ],
});
export const turn = (handle, at) => ({ kind: 'agent', turnId: `t-${handle}-${at}`, handle, sessionId: `se-${handle}`, status: 'done', at });

/** The run on today’s main: a pair card opened at 10 s; both refused hand-offs lost; the card allowed at 400 s. */
export function facts({ allowedAt = s(400), extraItems = [] } = {}) {
  return {
    threads: ['th1'],
    state: {
      items: {
        th1: [
          turn('researcher', s(1)),
          { kind: 'hop', from: 'researcher', to: 'critic', at: s(10), pair: 2, status: allowedAt ? 'allowed' : 'open' },
          turn('critic', s(20)),
          turn('developer', s(25)),
          ...(allowedAt ? [{ kind: 'voice', text: 'Allowed: @researcher wakes @critic', at: allowedAt }] : []),
          ...extraItems,
        ],
      },
    },
    streams: [wakeStream('critic', s(30), 'researcher', SENT), wakeStream('developer', s(100), 'critic', REFUSED)],
    hosts: {
      hosts: [{ id: 'h1', label: 'host1' }],
      placement: { researcher: 'local', critic: 'host1', developer: 'local' },
    },
  };
}
export const check = (id) => HOSTWAKE_CHECKS.find((c) => c.id === id);

/** A message Postbox sent an agent from another, as the runner reads it from the store (facts.received). */
export const received = (handle, from, at, text) => ({ handle, from, at, text });
