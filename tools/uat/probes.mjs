// What the runner saw on the page, by kind, for the checks and triggers to read (server/room-checks.mjs, tools/uat/triggers.mjs):
// - fullScreen, attachments: what an app’s Expand and an attached screenshot did (#45, #48)
// - answers: the revision of a block the runner read just before answering it (#123)
// - stale: the page’s notices that Postbox refused an answer as stale (#123)
// - interrupts: how the runner answered Stop’s question about background jobs (#126)
// - panels, panes, drafts: what the Agents section, the right pane and full screen showed (#105, #146)
// - jumps: where going to what an agent needs landed (#285, tools/uat/driver-needs.mjs)

export const newProbes = () => ({ fullScreen: [], attachments: [], answers: [], stale: [], interrupts: [], panels: [], panes: [], drafts: [], jumps: [] });
