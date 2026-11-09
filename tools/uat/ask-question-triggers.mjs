// #521's UAT trigger (tools/uat/triggers.mjs has what a trigger is): Claude Code's AskUserQuestion showed as a choice
// block (server/ask-question.mjs), the person picked an option, and the agent went on in the same turn, so the pick
// came back as the tool's result rather than as an event in a later turn. Read from the room's items as the run records
// them. A permission card for AskUserQuestion anywhere in the run means a question took the old path, so the trigger
// doesn't fire. Whether the reply uses the pick is the tester's to say.

import { itemsUnderTest } from './remote-facts.mjs';
import { clip } from './trigger-facts.mjs';

const QUESTION_TOOL = 'AskUserQuestion';

const answeredQuestion = (it) =>
  it.kind === 'block' && it.question === true && it.valid !== false && it.block?.type === 'choice' && it.answered === true && it.answer?.action === 'choose';

/** The labels the person picked, then their Other text, as the tool's answer joins them. */
function picked(it) {
  const selected = it.answer.values?.selected ?? [];
  const labels = (it.block.options ?? []).filter((o) => selected.includes(o.id)).map((o) => o.label);
  const other = it.answer.values?.other;
  return [...labels, ...(other ? [other] : [])].join(', ');
}

/** @type {Record<string, { issue: number, says: string, recorded: (f: any) => boolean, run: (f: any) => { at: number|null, evidence: string }[] }>} */
export const ASK_QUESTION_TRIGGERS = {
  'question-answered-in-turn': {
    issue: 521,
    says: 'an agent’s AskUserQuestion showed as a choice block, the person picked an option, and the agent went on in the same turn, with no permission card for it',
    recorded: (f) => !!f.state,
    run: (f) => {
      const items = itemsUnderTest(f);
      if (items.some((it) => it.kind === 'permission' && it.tool === QUESTION_TOOL)) return [];
      return items.flatMap((it, i) => {
        if (!answeredQuestion(it)) return [];
        const reply = items
          .slice(i + 1)
          .find((x) => x.kind === 'agent' && x.threadId === it.threadId && x.handle === it.handle && x.turnId === it.turnId && String(x.text ?? '').trim());
        if (!reply) return [];
        return [
          {
            at: Number.isFinite(it.answer.at) ? it.answer.at : null,
            evidence: `@${it.handle} asked “${clip(it.block.prompt, 80)}”, the person picked “${clip(picked(it), 60)}”, and its reply in the same turn said: “${clip(reply.text.trim(), 100)}”`,
          },
        ];
      });
    },
  },
};
