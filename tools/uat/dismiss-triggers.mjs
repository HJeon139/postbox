// #883's UAT trigger (tools/uat/triggers.mjs has what a trigger is): the person dismissed a failed reply, so the run
// reached Dismiss rather than Retry. Read from the room's items as the run records them: an agent reply whose turn
// failed and that carries `dismissed`. Whether the page then drew it quietly, with Retry only, is the tester's to check.

import { itemsUnderTest } from './remote-facts.mjs';
import { clip } from './trigger-facts.mjs';

/** A failed reply the person dismissed; one Retry later ran again still counts, since it was dismissed first. */
const dismissedReply = (it) => it.kind === 'agent' && it.dismissed === true && (it.status === 'failed' || it.status === 'retried');

/** @type {Record<string, { issue: number, says: string, recorded: (f: any) => boolean, run: (f: any) => { at: number|null, evidence: string }[] }>} */
export const DISMISS_TRIGGERS = {
  'failed-reply-dismissed': {
    issue: 883,
    says: 'the person dismissed a failed reply instead of retrying it',
    recorded: (f) => !!f.state,
    run: (f) =>
      itemsUnderTest(f)
        .filter(dismissedReply)
        .map((it) => ({
          at: Number.isFinite(it.at) ? it.at : null,
          evidence: `@${it.handle}’s failed reply was dismissed: “${clip(it.error ?? 'its turn failed', 80)}”${it.status === 'retried' ? ', then retried' : ''}.`,
        })),
  },
};
