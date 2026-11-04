// Triggers for what an agent is told is waiting for it (#694): a newer message from the sender of the message it’s
// answering, named on a Postbox tool result in the same turn (server/newer-waiting.mjs). tools/uat/triggers.mjs adds
// them to TRIGGERS. Each reads only the turns’ recorded streams, where the tool results are.

import { postboxCalls } from './postbox-calls.mjs';

/** The note’s opening, as server/newer-waiting.mjs writes it. */
const NOTE = /\[Postbox\] A newer message from (@[\w-]+|the person) is waiting for you;/;

/** Each Postbox tool result that named a newer waiting message to the agent answering its sender. */
function newerWaitingNamed(f) {
  const out = [];
  for (const call of postboxCalls(f.streams)) {
    // Postbox’s notes come before the result’s body, so a note quoted in a read result doesn’t count.
    const note = NOTE.exec(call.text.split('\n\n')[0]);
    if (note) out.push({ at: call.at, evidence: `@${call.handle}’s ${call.name} result named a newer message from ${note[1]}.` });
  }
  return out;
}

export const WAITING_TRIGGERS = {
  'newer-waiting-named': {
    issue: 694,
    says: 'a newer message from the sender an agent was answering was named on its next Postbox tool result',
    recorded: (f) => Array.isArray(f.streams),
    run: newerWaitingNamed,
  },
};
