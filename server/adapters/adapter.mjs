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
//   capabilities.promptTool: false    it never asks through Postbox’s permission_prompt (the CLI’s --permission-prompt-tool),
//                                     so MCP doesn’t list it and refuses a call to it at once (#220)
// Left out, an adapter is taken to fork and read rules, with Claude’s models, as the Claude backends do, and to ask
// through permission_prompt, as the Claude Code CLI does. The page gets every adapter’s capabilities in /api/state
// (config.backends).

/**
 * @typedef {{ name: string, capabilities?: { fork?: boolean, permissions?: 'rules' | 'none', resume?: boolean, tools?: 'deny-list' | 'none', isolation?: boolean, promptTool?: boolean, models?: string[] },
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
