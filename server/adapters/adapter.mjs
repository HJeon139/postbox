// The adapter interface: the one place a model connects to Postbox.
//
// An adapter runs one turn at a time for a session. Postbox calls deliver() with the message the agent
// should respond to and a turn context. The adapter streams what the agent does through the context and
// returns (or resolves) when the turn ends. Everything else — blocks, apps, glossary terms, wakes — goes
// through the UI tools, which a real agent reaches over MCP and the mock reaches through ctx.tools.
//
//   message: { kind: 'user',     text, attachments? }            you wrote to the agent
//            { kind: 'event',    event: { blockId, revision?, action, values }, blockItemId? }   you acted in a block
//                                    (revision: the one you answered; blockItemId: Postbox’s own) or an app
//            { kind: 'agent',    from: '@handle', text }        another agent woke this one
//            { kind: 'wake',     note }                          a wake-up the agent scheduled
//            { kind: 'app-check', appId, problems[] }            the app it wrote failed a check
//            { kind: 'lint',     undefinedTerms[] }              its reply used terms it never defined
//            { kind: 'notice',   text }                          something Postbox wants it to know
//
//   ctx.text(delta)                         stream reply text (Markdown)
//   ctx.activity({ id, label, state, ms })  a tool call or step: running, done or failed
//   ctx.status({ state?, ctx?, subagents?, currentStep? })
//                                           state: 'think' | 'gen' | 'tool'; ctx: % of context used;
//                                           subagents: [{ name, state, ctx }]
//   ctx.compaction({ kept, total, summary })  the agent's context was summarized
//   ctx.sources([{ title, authors, year, url, note }])  citations for the current reply
//   ctx.reported({ mcpServers?, model?, effort? })  what the backend reported about the run: the MCP servers
//                                           that loaded, [{ name, status, source? }]; the model that answered;
//                                           the effort the turn was started with
//   ctx.tools.*                             the same tools MCP exposes (see server/tools.mjs)
//   ctx.signal                              aborted when you press Stop; stop work promptly
//   ctx.mcpUrl                              where a real agent connects for the UI tools
//   ctx.remote                              set when the turn runs on a remote host (#120), and then ctx.mcpUrl is
//                                           never used: { link, welcome, settings, folder, version, turn, nextTurn,
//                                           attach?, resumeInterrupted?, bring?, asksByPrompt?, attachments? } (RemoteContext
//                                           below)
//                                           link: server/remote/link.mjs’s createHostLink; welcome: the daemon’s
//                                           latest (home, node.path, harnesses); settings: the host’s
//                                           (shared/remote-settings.mjs); folder: the host folder it works in;
//                                           version: Postbox’s package version (config.build.version), which names
//                                           the host’s code folder, so the shim is hostPaths(welcome.home,
//                                           version).shim (never welcome.version, the protocol’s).
//                                           The runtime owns host turn IDs: turn is the one this deliver runs as,
//                                           already persisted with the session as { hostId, turn, offset } (L5), so
//                                           the runtime can send the snapshot before `start` and attach after a
//                                           restart. An adapter that needs a second host turn in one deliver (a
//                                           resume whose session the host lost, a fork point it can’t find) awaits
//                                           nextTurn(), which persists the new one before it returns. The adapter
//                                           spawns through server/remote/process.mjs’s remoteSpawn with that ID and
//                                           makes none of its own. Codex also takes attach: { turn } (the turn to
//                                           pick up after a restart, instead of turn), Claude Code
//                                           resumeInterrupted. attachments: the message’s files, which every start
//                                           carries (server/remote/attachments.mjs); the message names their copies
//                                           on the host through remote-turn.mjs’s attachmentPaths, never ctx.pathOf.
//
// Throw (or reject) to fail the turn; the message is shown to you with Retry.
//
// An adapter may declare what it can’t do (#117), and the runtime and the UI read it rather than its name:
//   capabilities.fork: false          a topic thread’s agent starts fresh, with the thread’s root message (#81)
//   capabilities.permissions: 'none'  it doesn’t read Claude Code’s permission rules or MCP config, so the panel and
//                                     the persona sheet hide them
//   capabilities.models: [ids]        the models it offers, suggested in the model field instead of Claude’s
//   capabilities.tools: 'none'        it can’t turn a tool off for one agent, so the Tools help says so (#143)
//   capabilities.isolation: false     it always loads your own setup, so the sheet has no Isolated switch (#143)
//   capabilities.promptTool: false    it never asks through Postbox’s permission_prompt (the CLI’s --permission-prompt-tool),
//                                     so MCP doesn’t list it and refuses a call to it at once (#220)
//   capabilities.remote: { ... }      how it runs on a remote host, where the daemon starts its process (#120):
//     stdin: 'file' | 'none' | 'held'   the turn’s message goes in a file, or nothing goes in, or stdin stays open
//                                       until the turn ends (Codex’s JSON-RPC)
//     env: [names]                      the variables it sets on purpose, the only ones that reach the host, such as
//                                       KIRO_HOME for an Isolated Kiro persona; the rest of the laptop’s don’t
//     server: 'mcp-config' | 'agent-file' | 'codex-config'  where Postbox’s server is named: --mcp-config, the
//                                       custom agent file, or Codex’s -c mcp_servers.postbox.* overrides
//     work: 'events' | 'open-tool-call' | 'model-checks'  its sign of work while quiet, so a quiet turn isn’t taken
//                                       for a hung one: events on stdout (Claude Code’s tool_progress), a tool call
//                                       still in progress (Kiro prints nothing while a command runs), or the
//                                       model’s checks on a background command (Codex, about every 5 minutes)
//     signInError: { field: value } | null  the fields of a stream event that mean the host’s sign-in ran out, so
//                                       the turn shows Sign-in needed rather than an error; null until one is recorded
//   Left out, it can’t run on a remote host: the Agent SDK runs in Postbox’s own process, and the Antigravity CLI and
//   the mock aren’t covered yet.
// Left out, an adapter is taken to fork and read rules, with Claude’s models, as the Claude backends do, and to ask
// through permission_prompt, as the Claude Code CLI does. The page gets every adapter’s capabilities in /api/state
// (config.backends).

/**
 * @typedef {{ stdin: 'file' | 'none' | 'held', env: string[], server: 'mcp-config' | 'agent-file' | 'codex-config',
 *   work: 'events' | 'open-tool-call' | 'model-checks', signInError: Record<string, unknown> | null }} RemoteCapabilities
 */

/**
 * @typedef {{ name: string, capabilities?: { fork?: boolean, permissions?: 'rules' | 'none', resume?: boolean, tools?: 'deny-list' | 'none', isolation?: boolean, promptTool?: boolean, models?: string[],
 *   remote?: RemoteCapabilities },
 *   deliver(session: object, message: object, ctx: object): Promise<void>, dispose?(session: object): void }} Adapter
 */

/**
 * A turn’s remote context (#120), as the runtime passes it in ctx.remote.
 * @typedef {{ link: any, welcome: any, settings: Record<string, any>, folder: string, version: string,
 *   turn?: string, nextTurn: () => Promise<string>, attach?: { turn: string }, resumeInterrupted?: boolean, bring?: boolean,
 *   asksByPrompt?: boolean, attachments?: import('../remote/attachments.mjs').RemoteAttachment[] }} RemoteContext
 *   asksByPrompt: false for a backend that doesn’t ask through permission_prompt (server/permission-prompt.mjs)
 */

/**
 * The host’s shim’s arguments for host turn `turn`: its path, the turn, --bring when the runtime says the turn may
 * post to the conversation (ctx.remote.bring: one the person started in a side or topic thread), so the shim lists
 * bring_to_conversation as the laptop’s server would, and --no-prompt for a backend that doesn’t ask through
 * permission_prompt, which the shim then doesn’t list either (server/remote/host/shim.mjs).
 * @param {RemoteContext} remote @param {string} shim @param {string} turn
 */
export const shimArgs = (remote, shim, turn) => [shim, turn, ...(remote.bring ? ['--bring'] : []), ...(remote.asksByPrompt === false ? ['--no-prompt'] : [])];

/**
 * Refuses a remote context the runtime didn’t fill in, before anything starts on the host: the turn ID it owns (an
 * attach brings its own) and Postbox’s version, which names the shim’s folder there.
 * @param {RemoteContext} remote @param {{ attach?: boolean }} [o]
 */
export function checkRemoteContext(remote, { attach = false } = {}) {
  if (!attach && (typeof remote.turn !== 'string' || !remote.turn))
    throw new Error('A remote turn needs its turn ID from the runtime (ctx.remote.turn), so it wasn’t started on the host.');
  if (typeof remote.version !== 'string' || !remote.version)
    throw new Error('A remote turn needs Postbox’s version (ctx.remote.version) to find the shim on the host, so it wasn’t started.');
  if (!attach && typeof remote.nextTurn !== 'function')
    throw new Error('A remote turn needs ctx.remote.nextTurn from the runtime, so it wasn’t started on the host.');
}

export class AdapterRegistry {
  constructor() {
    this.adapters = new Map();
    /** The backends registered to run only on a host: their CLI isn’t on this computer (#120). */
    this.hostOnly = new Set();
  }
  /**
   * An adapter runs on this computer unless it’s registered with here: false. server/index.mjs registers Claude Code,
   * Kiro CLI and Codex that way when their CLI isn’t found, so an agent can still run them on a host; anything else
   * (the mock, or a scripted adapter a check or test puts in) runs here. Registering a name again replaces its adapter
   * and where it runs.
   * @param {any} adapter @param {{ here?: boolean }} [o]
   */
  register(adapter, { here = true } = {}) {
    this.adapters.set(adapter.name, adapter);
    if (here) this.hostOnly.delete(adapter.name);
    else this.hostOnly.add(adapter.name);
    return this;
  }
  /** Whether a registered backend runs on this computer. @param {string} name */
  runsHere(name) {
    return this.adapters.has(name) && !this.hostOnly.has(name);
  }
  get(name) {
    const a = this.adapters.get(name);
    if (!a) throw new Error(`No adapter is registered for “${name}”. See README, “Run real agents”.`);
    return a;
  }
  names() {
    return [...this.adapters.keys()];
  }
}
