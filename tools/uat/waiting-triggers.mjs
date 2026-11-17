// Triggers for what an agent is told is waiting for it (#694): a newer message from the sender of the message it’s
// answering, named on a Postbox tool result in the same turn (server/newer-waiting.mjs), and one waiting in another
// thread, named on a result or in the prompt of a turn that starts while it waits (#734). tools/uat/triggers.mjs adds
// them to TRIGGERS. The first reads the turns’ recorded streams, where the tool results are; the second, Claude Code’s
// transcripts, where the prompts are too.

import { postboxCalls } from './postbox-calls.mjs';
import { inputsOf } from './room-delivery.mjs';

/** The note’s opening, as server/newer-waiting.mjs writes it, with the thread it waits in when that’s another. */
const NOTE = /\[Postbox\] A newer message from (@[\w-]+|the person) is waiting for you(?: in “[^”]*”)?;/;
/** The note for one waiting in another thread. */
const ELSEWHERE = /\[Postbox\] A newer message from (@[\w-]+|the person) is waiting for you in “([^”]*)”;/;

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

/** Each prompt or tool result that named a newer message from its sender waiting in another thread (#734). */
function newerElsewhereNamed(f) {
  const out = [];
  for (const handle of new Set((f.transcripts ?? []).map((/** @type {any} */ t) => t.handle)))
    for (const x of inputsOf(f, handle) ?? []) {
      const note = ELSEWHERE.exec(x.text ?? '');
      if (note) out.push({ at: x.at, evidence: `@${handle}’s ${x.kind} named a newer message from ${note[1]} waiting in “${note[2]}”.` });
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
  'newer-elsewhere-named': {
    issue: 734,
    says: 'a newer message from an agent’s sender waiting in another thread was named in its prompt or on a tool result',
    recorded: (f) => Array.isArray(f.transcripts),
    run: newerElsewhereNamed,
  },
};
