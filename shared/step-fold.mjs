// What a finished turn keeps of each step (designs/rooms-at-scale.md, “Live state”: progress is live, and a turn keeps
// one record of its steps when it ends). The live view’s detail goes: a call’s input, the end of what it returned, an
// edit’s diff, where the step fell in the reply’s words and the part it showed in. A thought keeps as much as any other
// detail. An edit’s counts stay. The server folds them with one small item.patch (server/runtime.mjs, endTurn), which
// this applies wherever the state is kept (shared/state.mjs), so the log doesn’t carry the list again.

import { STEP_TEXT } from './limits.mjs';

const LIVE = ['input', 'output', 'diff', 'at', 'part'];

/** A step as its finished turn keeps it. @param {Record<string, any>} s */
export function foldedStep(s) {
  const kept = { ...s };
  for (const k of LIVE) delete kept[k];
  if (typeof kept.detail === 'string' && kept.detail.length > STEP_TEXT.detail) kept.detail = kept.detail.slice(0, STEP_TEXT.detail);
  return kept;
}
