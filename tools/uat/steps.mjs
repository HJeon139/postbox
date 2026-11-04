// The tester’s actions that live in modules of their own, by type: tools/uat-run.mjs runs each with what it needs
// ({ d, page, api, keys, facts, step }) and the action, and says what it returns. One table, so a new one costs the
// runner, which is at its size, no lines.

import { conversationStep } from './conversation-step.mjs';
import { goToNeedsStep } from './driver-needs.mjs';
import { scrollStep } from './scroll-step.mjs';

export { localRestart } from './conversation-step.mjs';

export const STEPS = Object.freeze({ go_to_needs: goToNeedsStep, conversation: conversationStep, scroll: scrollStep });

/**
 * What an interrupt does once the agent has worked its seconds: stop and send_now are the driver’s own; a fault, a
 * conversation action (a delete during the turn, #723) and an answer to a block run as the driver’s answer.
 * @param {any} interrupt @param {{ fault: (i: any) => Promise<string>, answer: (i: any) => Promise<string>, ctx: any }} runner
 * @returns {{ do: string, answer: () => Promise<string> }}
 */
export function interruptAct(interrupt, { fault, answer, ctx }) {
  const act = { fault: () => fault(interrupt), conversation: () => STEPS.conversation(ctx, interrupt) }[interrupt.do];
  return { do: act ? 'answer' : interrupt.do, answer: act ?? (() => answer(interrupt)) };
}
