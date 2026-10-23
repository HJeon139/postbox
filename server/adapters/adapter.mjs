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
// Left out, an adapter is taken to fork and read rules, with Claude’s models, as the Claude backends do. The page
// gets every adapter’s capabilities in /api/state (config.backends).

/**
 * @typedef {{ stdin: 'file' | 'none' | 'held', env: string[], server: 'mcp-config' | 'agent-file' | 'codex-config',
 *   work: 'events' | 'open-tool-call' | 'model-checks', signInError: Record<string, unknown> | null }} RemoteCapabilities
 */

/**
 * @typedef {{ name: string, capabilities?: { fork?: boolean, permissions?: 'rules' | 'none', resume?: boolean, tools?: 'deny-list' | 'none', isolation?: boolean, models?: string[],
 *   remote?: RemoteCapabilities },
 *   deliver(session: object, message: object, ctx: object): Promise<void>, dispose?(session: object): void }} Adapter
 */

export class AdapterRegistry {
  constructor() {
    this.adapters = new Map();
  }
  register(adapter) {
    this.adapters.set(adapter.name, adapter);
    return this;
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
