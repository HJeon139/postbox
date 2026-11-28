// The tester’s `send` action (tools/uat-run.mjs): it writes a message in the conversation, and says where a message
// went that names an agent without its @. Moved from tools/uat-run.mjs, which is at its size.

import { unaddressed } from './tester.mjs';

/**
 * Sends the tester’s message, and returns what the tester should know about where it went, or null.
 * @param {{ send: (text: string) => Promise<unknown> }} d  the driver
 * @param {{ text?: string }} a  the action
 * @param {{ state: any, mainThread: string }} o  state: Postbox’s state as the step read it
 * @returns {Promise<string | null>}
 */
export async function sendStep(d, a, { state: st, mainThread }) {
  await d.send(a.text ?? '');
  // A message that addresses an agent by name without its @ goes to the last speaker, not to that agent: say
  // so, so the tester knows where it went. The first mixed-room run wrote “critic: …” and “researcher: …”.
  // Who Postbox sends it to: the last speaker, or before anyone has spoken, the conversation’s first agent.
  const t = st?.threads?.[mainThread];
  const last = st?.sessions?.[t?.lastSpeaker ?? t?.members?.[0]]?.handle ?? null;
  const named = unaddressed(
    a.text ?? '',
    Object.values(st?.personas ?? {}).map((p) => p.handle),
    { lastSpeaker: last },
  );
  if (named.length)
    return `It addresses “${named[0]}” without the @, so it mentions no agent and went to ${last ? `@${last}, who spoke last` : 'whichever agent spoke last'}. Write @${named[0]} to address it.`;
  return null;
}
