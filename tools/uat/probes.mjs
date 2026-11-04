// What the runner saw on the page, by kind, for the checks and triggers to read (server/room-checks.mjs, tools/uat/triggers.mjs):
// - fullScreen, attachments: what an app’s Expand and an attached screenshot did (#45, #48)
// - answers: the revision of a block the runner read just before answering it (#123)
// - stale: the page’s notices that Postbox refused an answer as stale (#123)
// - interrupts: how the runner answered Stop’s question about background jobs (#126)
// - panels, panes, drafts: what the Agents section, the right pane and full screen showed (#105, #146)
// - jumps: where going to what an agent needs landed (#285, tools/uat/driver-needs.mjs)
// - diagrams, once the conversation has one: which diagram frames had loaded, and which were in view (#701,
//   tools/uat/diagram-probe.mjs); a run with none has no such probe, so its trigger can’t tell
// - inputs: every input the run made that can move the person’s view, by step (#531): the tester’s scroll, and the
//   runner’s clicks, which scroll what they click into view; and, as the runner’s (cause: 'runner'), a shot that didn’t
//   leave the view as it was (tools/uat/driver-shots.mjs, keepView). A run saved before these were recorded has none.
// - keyFrame: the key-to-frame measurements --measure-key-frame made of the run’s room (#508, tools/uat/key-frame-run.mjs)
// - keyFrameOn: whether the run had --measure-key-frame on, so a run without it, or one saved before this was, can’t
//   say it didn’t measure (tools/uat/triggers-measure.mjs)

export const newProbes = () => ({
  fullScreen: [],
  attachments: [],
  answers: [],
  stale: [],
  interrupts: [],
  panels: [],
  panes: [],
  drafts: [],
  jumps: [],
  conversation: [],
  inputs: [],
  keyFrame: [],
  keyFrameOn: false,
});

/**
 * Records an input into probes.inputs, stamped with the step it’s in and when; a shot that moved the person’s view is
 * logged too.
 * @param {{ inputs: any[] }} probes  @param {() => number} stepNow  @param {(line: string) => void} log
 */
export const recordInput = (probes, stepNow, log) => (/** @type {any} */ entry) => {
  probes.inputs.push({ step: stepNow(), at: Date.now(), ...entry });
  if (entry.cause === 'runner') log(`the runner moved the ${entry.where} view: ${JSON.stringify(entry.before)} → ${JSON.stringify(entry.after)}`);
};
