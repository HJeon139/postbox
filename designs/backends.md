# Real agents and their backends

The five backends an agent can run on, what each needs, its permission modes and what differs between them, and how to bring your own.

## Run real agents

A persona runs on one of five backends. Pick one in the new-agent sheet, under **Backend**. Three of them can also run on another computer: see [remote-hosts.md](remote-hosts.md).

| Backend | What it runs | Needs |
|---|---|---|
| Claude Code | The `claude` CLI you’re signed in to, in print mode. Each thread is one Claude Code session, resumed every turn. | Claude Code installed (`claude --version` works), or `POSTBOX_CLAUDE_BIN` pointing at it |
| Agent SDK | `query()` from `@anthropic-ai/claude-agent-sdk`, inside Postbox’s server | `npm install` |
| Kiro CLI | The `kiro-cli` you’re signed in to, headless (`kiro-cli chat --agent-engine v3 --output-format stream-json`). Each thread is one Kiro session, resumed every turn. | Kiro CLI installed (`kiro-cli --version` works), or `POSTBOX_KIRO_BIN` pointing at it |
| Antigravity CLI | The `agy` CLI you’re signed in to, headless (`agy --output-format stream-json --print`), with Gemini models. Each thread is one conversation, resumed every turn. | Antigravity CLI installed (`agy --version` works), or `POSTBOX_AGY_BIN` pointing at it |
| Codex | The `codex app-server` you’re signed in to. Postbox starts and resumes an app-server thread for each conversation. | Codex CLI installed (`codex --version` works) and signed in, or `POSTBOX_CODEX_BIN` pointing at it |
| Mock agent | The scripted agent the demo uses | Nothing |

Postbox never reads, stores or asks for an API key. The Claude backends use Claude Code’s own sign-in, or `ANTHROPIC_API_KEY` if your environment already sets it; the Kiro CLI uses its own sign-in, or `KIRO_API_KEY`; the Antigravity CLI uses its own sign-in. Postbox starts each backend only if it can run here; the server’s first lines list the ones it found. `POSTBOX_BACKENDS=mock` turns the real ones off.

**Model.** New agents use `claude-opus-5-5`. Any model name Claude Code accepts works; change it per persona under **Personas**.

**Permissions.** Each persona has one of four modes:

| Mode | The agent… |
|---|---|
| Auto (the default) | runs routine actions without asking: Claude Code’s safety classifier approves them. When it can’t decide, the agent asks you, the same way as Ask me. |
| Ask me | asks before it runs a command or changes a file. Postbox shows the exact command in a card in the thread, the agent needs you, and the tool call waits for **Allow** or **Don’t allow**. Stop answers no. |
| Accept edits | edits files in its folders freely, and asks before it runs commands |
| Run everything | never asks. Use it only in a folder you can lose. |

Postbox always passes the mode explicitly, so a default from your own Claude Code settings never changes it. A change to a persona’s mode, or to where it runs, reaches its conversations from their next turn.

**Hooks.** In Ask me and Accept edits, a Claude Code or Agent SDK agent’s turns run without the hooks in your settings files and plugins, and without your custom status line, since a hook that approves a tool call would skip Postbox’s ask rules for writes outside it and its permission cards ([#817](https://github.com/HJeon139/postbox/issues/817)). In Auto and Run everything your hooks run, as in your terminal: in Auto Postbox adds no write ask rules of its own. It still shows a card when Claude Code itself asks, and for your ask rules and the conversation’s, and one of your hooks that approves a call skips those cards there, as it would skip your ask rules in your terminal ([#806](https://github.com/HJeon139/postbox/issues/806)). A turn that started with your hooks on keeps its mode until it ends rather than switch into Ask me or Accept edits. Your terminal’s Claude Code is unchanged. The permissions panel lists each `PreToolUse` and `PermissionRequest` hook it finds in `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR/settings.json`), only when the agent uses your setup, and in the agent folder’s `.claude/settings.json` and `.claude/settings.local.json`. When a persona names its own folder, that’s the folder it reads, not the project’s. For an agent on a host, those are this computer’s files, not the host’s. Hooks your organization manages always run, and one of those can still approve a call without a card.

**Folders.** An agent works in its project’s root folder, or in the folder its persona names, or, if neither is set, in `workspaces/<name>` in the data folder. If its persona names a folder, it can also read the project’s. Its permission mode decides what it may change. Postbox’s own tools (show_block and the rest) never ask; they only show things in the thread.

**The Kiro CLI.** Each turn, Postbox writes a Kiro custom agent with the guide as its prompt, Postbox’s MCP server and the persona’s rules, and removes it when the turn ends ([`server/adapters/kiro-cli.mjs`](../server/adapters/kiro-cli.mjs)). What differs from Claude Code:
- **It can’t ask you.** A headless Kiro run treats every ask as a refusal, so there’s no permission card: a call that would need asking shows as a denied step. Ask me means Kiro’s defaults plus reads in the agent’s folders; Accept edits adds writes there; Auto, since Kiro has no Auto of its own, runs what the agent’s Tools allow, with Shell any command, with Web any search or fetch, any MCP tool that doesn’t publish, and writes in its folders, with nothing judging those calls (#136); in both, writes to the folders’ `.kiro` and `.git` stay refused; Run everything is `--trust-all-tools`, and unticked Tools stay denied. Claude Code rules (the permissions panel, Allow once) don’t apply.
- **Your setup.** With **Uses your Kiro setup**, it runs with your Kiro home (`KIRO_HOME`, else `~/.kiro`): your steering, skills, settings and MCP servers load, and the turn’s agent file is written to its `agents` folder for the turn. Off, it runs with `kiro-home` in the data folder, and a deny rule turns off every MCP server but Postbox’s, including one a managed install adds to Kiro’s agent files by itself. A `.kiro` folder in the agent’s working folder loads either way.
- **Models** are Kiro’s (`kiro-cli chat --list-models`), and the model field suggests the ones your sign-in offers, Claude’s and others such as GPT and DeepSeek. Postbox’s names become Kiro’s: `claude-opus-5-5` runs as `claude-opus-5.5`.

**The Antigravity CLI.** agy has no flag for an MCP server or a system prompt, so each turn writes a plugin into the agent’s folder, `.agents/plugins/postbox/`, with Postbox’s MCP server and the guide as its rules, and removes it when the turn ends ([`server/adapters/antigravity-cli.mjs`](../server/adapters/antigravity-cli.mjs)). In a git repository, that path goes in `.git/info/exclude`. Two Antigravity agents that share a folder take turns, since each turn’s plugin holds its own conversation. What differs from Claude Code:
- **One line in your agy settings.** Headless, agy refuses every tool call it would ask about, Postbox’s own included. So the first turn adds `mcp(postbox_postbox/*)` to `permissions.allow` in `~/.gemini/antigravity-cli/settings.json`, and keeps the rest of the file. Only Postbox’s plugin names that server, and it exists only while a turn runs.
- **How it asks.** With agy 1.4.7 or newer, Postbox’s PreToolUse hook decides each call, and a call that needs asking comes to you as a card. agy’s own Auto isn’t offered on every account, so **Auto** works like Run everything for the tools you give the agent: with Shell, any command; with Web, any search or fetch; and any MCP tool that doesn’t publish, with nothing judging them (#416). Without those tools, Auto runs everyday reads and asks about the rest. A tool on Postbox’s publishing list is refused unless the agent can publish: a `gh` command through Shell isn’t on it. Before agy 1.4.7, a call that would need asking shows as a denied step, and Postbox resumes the conversation once for the agent to say what was refused. Claude Code rules don’t apply.
- **A read outside its folders** asks on a card. Always allow makes that file’s folder readable for that agent in this conversation, listed in the permissions panel as “Read only, in this conversation”: the agent may read there, never edit there with no card. It’s never offered for `/`, your home folder or a dot-folder in it such as `~/.ssh`, nor for an agent on a host (#338).
- **Tools are a request.** agy reads deny rules only from your own settings, which every agy session shares, so a persona’s unticked Tools can’t be turned off for one agent. The agent is told not to use them.
- **Always your setup.** agy reads its config from `~/.gemini` and has no setting to move it, so there’s no Isolated mode: your rules, skills, plugins and MCP servers load, as in your terminal.
- **Models** are agy’s (`agy models`): Gemini’s, and others such as Claude and GPT-OSS. A persona that names no model runs `gemini-3.8-flash-high`. Effort is part of some model ids (`gemini-3.8-flash-low`), so it’s passed only to a model that takes it, such as `gemini-3.8-flash` (up to High).

**Codex.** Postbox uses the local `codex app-server` JSON-RPC protocol, with Codex’s own sign-in and configuration; it does not ask for an API key. It adds Postbox’s session-specific MCP endpoint to the Codex server, streams Codex text and tool activity, and resumes each saved thread on the next turn. Stop sends `turn/interrupt` and then stops the child process if needed. Model suggestions come from app-server’s `model/list` catalog.

Codex permission modes map to its sandbox and approval policy: **Ask me** uses read-only; **Auto** uses workspace-write, with network access on for an agent that may fetch the web, and Codex’s own reviewer judges what the sandbox stops; **Accept edits** uses workspace-write with network access off and approvals on request; and **Run everything** uses full access with approvals disabled. Its approval requests appear as Postbox permission cards. Codex doesn’t read Claude Code permission rules, and of the per-agent Tools only Web counts: in Auto it turns network on in Codex’s sandbox. Always allow on a Codex card saves exactly the command prefix or host Codex proposed as a Codex rule, in `rules/default.rules` in your Codex home. A command that matches it runs outside Codex’s sandbox, with no card, in every Codex session on the computer, so the card offers one only for a few programs that read and print (such as `ls`, `cat`, `grep`, `gh pr view` and `gh issue list`), only to an agent with Web, and none on a host’s card. A host is offered only in Auto, for an agent with Web. Codex reads its usual local configuration, including any MCP servers already configured there.

**Attach a Claude Code session.** Choose **+**, then **Attach a Claude Code session**, to bring in one you started in a terminal. It joins as an agent working in that session’s folder, with its recent history. When you write to it, Postbox resumes that same session. When you type in the terminal, your turn and the agent’s reply appear in the thread, marked “from terminal”. Let a terminal turn finish before you write to it from Postbox.

**Your own adapter.** All model access goes through one interface, in [`server/adapters/adapter.mjs`](../server/adapters/adapter.mjs):

```js
export class MyAdapter {
  name = 'my-backend';                      // a persona’s `backend` picks its adapter
  capabilities = { permissions: 'none' };   // optional: it doesn’t read Claude Code’s rules
  async deliver(session, message, ctx) {    // one turn; resolve when it ends, throw to fail it
    ctx.status({ state: 'think', ctx: 12 }); // ring state and % of context used
    ctx.activity({ id: 't1', label: 'Read schema.md', state: 'running' });
    ctx.text('Streaming **Markdown**…');     // reply text, in chunks
    const ok = await ctx.askPermission({ tool: 'Bash', summary: 'run a command', detail: 'npm test' });
    // Blocks, apps, glossary terms and wakes go through the UI tools:
    //   in-process: ctx.tools.show_block({ block }), or over MCP at ctx.mcpUrl
    if (ctx.signal.aborted) return;          // Stop aborts the signal
  }
}
```

Every real adapter shares a system prompt that teaches the catalog, the kit and the [recipes](recipes.md) ([`server/adapters/guide.mjs`](../server/adapters/guide.mjs)), and the mapper from a stream’s events to the turn context ([`server/adapters/claude-stream.mjs`](../server/adapters/claude-stream.mjs)).

**MCP.** The UI tools are served over JSON-RPC 2.0 at `POST /mcp?session=<session id>&turn=<token>` ([`server/mcp.mjs`](../server/mcp.mjs)). Postbox gives each turn it starts its own token, and a tool call without the running turn’s token is refused (#54), so only an agent turn Postbox started can call them, not a script that knows a session id. A large app goes by `codePath`, a file in the agent’s folder, and an app’s data files by `files`, which the app reads with `postbox.file(name)`. The tools:
- `show_block`, `update_block`, and `review_block`, which comments on another agent’s review block, line by line or on a selection, with a verdict; each comment becomes a thread on the draft, its agent hears them, and the block still waits on you (#133)
- `show_app`, `update_app`, and `retire_app`, which leaves an app that’s no longer needed as one line in its place, with a link to what replaced it and its versions (#193)
- `define_term`
- `propose_agent`
- `schedule_wake`, and `cancel_wake`, which cancels a wake the agent scheduled, once its work is done (#458)
- `wake_agent`
- `open_topic`, which opens the topic thread of a message in the agent’s conversation, or finds the one it has, and can post a first message there that wakes up to 16 agents it names; its answer says whether that message was posted, by its id (#637)
- `bring_to_conversation`, which posts in the main conversation from a topic or side thread, only when you ask for it there (#128)
- `ask_for_tool`, which asks you on a card to turn on a tool that’s turned off for the agent
- `read_conversation`, the conversation’s history (each turn already starts with what happened since the agent’s last one). A block comes with what it holds: a review, card or code block’s content, a choice or form’s prompt, options or fields and your answer, an app’s title. Both cut an item at 2,000 characters, saying how much they kept and giving its id.
- `read_message`, one item in full by that id or a block’s id, 40,000 characters at a time
- `react`, a reaction on a message, block or app by its id, as you react (#270): the agent whose message it is hears it at its next turn, and calling it again takes it back
- `list_assets`, `read_asset`, `write_asset`, `rename_asset`, `delete_asset` and `restore_asset`, the files a conversation keeps, where each write is a new version and the earlier ones stay ([`server/asset-tools.mjs`](../server/asset-tools.mjs), #516); data an agent brings in goes there too
- `search_assets`, which searches the conversation’s text assets with BM25 and a stub meaning score, a passage at a time ([`server/asset-search.mjs`](../server/asset-search.mjs), #516)
- `permission_prompt`, which Claude Code calls before a tool that needs your OK

Every tool except `permission_prompt` returns at once. When you answer a block, your answer arrives later as an `event` message.
