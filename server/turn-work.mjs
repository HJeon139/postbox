// What a turn’s adapter tells the runtime about its tool calls, for the work ledger (#132): part of the turn’s context
// (runtime.mjs, turnContext), each taken only while the turn is live.

import { recordScheduledTool } from './scheduled-wakes.mjs';

/**
 * Each tool call with its whole input, before it runs ({ id, name, input, who }); what it returned ({ id, isError,
 * text, result: the tool’s own record, vcsCwd }); a background task’s end ({ toolUseId, status, summary, outputFile });
 * and the process’s running spend ({ key, costUsd, tokens }).
 * @param {any} rt @param {any} turn @param {() => boolean} live
 */
export function workEvents(rt, turn, live) {
  return {
    /** @param {any} u */
    toolUse(u) {
      if (live()) recordScheduledTool(rt, turn, u);
    },
    /** @param {any} r */
    toolResult(r) {
      if (live()) rt.ledger.toolResult(turn, r);
    },
    /** @param {any} t */
    taskEnded(t) {
      if (live()) rt.ledger.taskEnded(turn, t);
    },
    /** @param {any} u */
    usage(u) {
      if (live()) rt.ledger.usage(turn, u);
    },
  };
}
