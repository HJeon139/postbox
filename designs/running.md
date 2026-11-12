# Running Postbox

How to install and run Postbox, what its conversations, threads and Work view do, how to run real agents on this computer and on remote hosts, and what it can’t do yet. The README is the short version; this page has every detail. The design behind it is in [intent.md](intent.md) and [architecture.md](architecture.md).

## Run it

Postbox needs Node 22 or later. It runs with no dependencies at all. From a clone:

```bash
npm start
```

**As a package.** Postbox isn’t published to npm yet, so pack it from a clone and install the file it makes, which gives you a `postbox` command:

```bash
npm pack
```

```bash
npm install -g ./postbox-<version>.tgz
```

```bash
postbox
```

A global install brings the optional packages too (the Agent SDK and Kokoro, several hundred MB); add `--omit=optional` to a project install to leave them out. `postbox --help` lists its flags: `--port`, `--data`, `--fresh`, `--demo`, `--move-data`, `-v` (`--version`) and `-h` (`--help`). The package holds only what runs (`bin/`, `app/`, `server/`, `shared/` and `agent-plugin/`, the skills Postbox gives its agents) and `CHANGELOG.md`, and its build line under **Personas** shows the commit it was packed from. Upgrading or uninstalling it leaves your conversations alone, since they’re in `~/.postbox`, not in the package.

Open <http://127.0.0.1:4173/>. Postbox listens only on this machine. Your conversations are kept in `~/.postbox` as an event log, so they survive a restart and an upgrade. Set `POSTBOX_HOME` to keep them somewhere else, or pass `--data <folder>` for one run. Add `--fresh` to start over.

**Agents waking agents.** After 1,000 agent wakes in a row without your message, the next waits for your Allow, as a backstop against agents that never stop. A room sets its own limit, from 1 to 10,000, in its menu (⋯ › Wake chain limit…); a room without one uses the server’s default, which `POSTBOX_CHAIN_LIMIT` sets, a whole number from 1 to 10,000 (#1035).

**A clone that ran an earlier version.** Earlier versions kept everything in the clone’s `data/` folder. A clone whose `data/` has conversations keeps using it, unless `POSTBOX_HOME` is set, and says so when it starts. To move it to `~/.postbox`, stop Postbox and run `npm start -- --move-data`: it moves the folder and leaves a link in its place, so paths your conversations recorded still work. An agent that works in its own workspace folder starts a new Claude Code session on its next turn, since its folder moved; its conversation in Postbox stays. Postbox never moves it without being asked.

One Postbox runs on a data folder at a time: a second one on the same folder refuses to start, and says which process has it.

A fresh install starts with three general-purpose agents and no projects or conversations: @researcher finds and cites sources, @developer changes code and verifies it, and @critic reviews code and documents. Their instructions are in [`server/personas/`](../server/personas/). Make a project for a folder you work in, start a conversation with any of them, and add agents of your own from **New agent**. They run on Claude Code if it’s installed and signed in (`claude --version` works), and on the mock otherwise. Agents from an earlier run keep their backend; change it under **Personas**, in **Runs on**.

To start with agents of your own instead, put an `agents.json` in the data folder before the first run: an array of personas such as `[{ "handle": "reviewer", "description": "Reviews my drafts.", "instructions": "…" }]`. It replaces the seeded agents, with or without `--demo`.

`--demo` seeds the demo’s reading-notes agents (@librarian, @indexer, @researcher and @critic), two projects and the sample conversations below, with a few short notes as the asset explorer’s and the shelf’s assets ([`server/demo-assets/`](../server/demo-assets/)), and always uses the mock, for the scripted tour. To use the Agent SDK, read aloud and run the development checks, install the optional packages once:

```bash
npm install
```

To watch the demo, which plays every block type and every error state on the mock (it starts its own Postbox in demo mode), run this and open the same address:

```bash
node tools/demo.mjs
```

Keep the page open while it plays: agent-written apps are checked in your browser before they’re shown.

Things to try in the demo’s conversations (`node server/index.mjs --demo --fresh --data data/demo`, which keeps them apart from your own):

| Conversation | Ask | You’ll see |
|---|---|---|
| Asset explorer | Build me an explorer for these assets | An agent-written app searching the conversation’s notes through the bridge, and a v2, filtered by asset, after you send passages |
| Catalog tour | Show me every kind of block you can send | One of each catalog block, all live |
| ReAct, step by step | Explain ReAct with something I can try · Walk me through ReAct, out loud · then **Reply in thread** under the explainer | Citations with hover cards, a diagram, math, a glossary term and a practice app · slides that follow a local voice · a topic thread, and Summarize back |
| Corpus schema spec | Review my corpus schema line by line | Markdown, code and app reviews, then a revision shown as a diff |
| Index the shelf | Index the shelf · Rebuild without the prefaces · Show it as a timeline · Show me the shelf map · Show me a dashboard · Clear the old index cache · Draw the whole indexing pipeline | Progress, subagents and a compaction · a failed reply with Retry · blocks Postbox can’t show · a crashed app · an app that fails its check and gets fixed · a permission card · a diagram too wide to read, flagged by the diagram linter and redrawn |
| Corpus planning | @indexer check the editions with the researcher, in a loop | Agents waking each other in a side thread until the limit asks you |
| Citation fixes | Fix the citation script · then Try a faster parser · then **Work** in the top bar, and its full-screen icon | Every file the agent changed with its diff and a copy from before, flagged changes, the commands as they ran, an issue it filed, and a turn that left nothing lasting |

## Conversations and threads

The **Postbox** menu in the top bar goes to any project, from anywhere, and Postbox opens on the conversation you were last in. In a project, the rail lists its **conversations**: direct messages with one agent, and rooms with several (**+** beside Rooms starts one with two or more agents). Each agent in a conversation has one session, and everything said there is shared: each turn starts with what the agent missed since its last one, so an agent you bring into a room knows what was discussed. ⌘\ hides the sidebar. The **⋯** beside a conversation’s title renames it, adds an agent, or deletes it, at once: there’s no Undo.

Any message can start a **topic thread**, as in Slack: choose **Reply in thread** under it. The thread opens in the panel beside the conversation. An agent you @-mention there answers from its one session in the conversation, so it remembers both: its prompt leads with the thread’s request as its task, and gives what happened in the room as background. The conversation’s other agents see that the thread exists, with a short summary, and read it only if they choose. To bring something back, choose **Send to conversation** under a reply, or **Summarize back** to have the thread’s agent post a short summary. The conversation’s agents read it at the start of their next turn. The rail’s **Threads** entry lists a project’s topic threads.

## Work

Each conversation has a **Work** view, opened with **Work** in the top bar: everything its agents’ work touched, and what it took ([#132](https://github.com/HJeon139/postbox/issues/132)). It covers every session in the conversation, side and topic threads included, so you never have to ask an agent to recount what it did.

- **Files** each agent’s edits changed, each with its diff, its lines added and deleted, and where it stands in git: uncommitted, committed or pushed. Lines are counted from the diff against the file before the agents’ first change, so five edits that end where they began count as nothing. A change outside the project, or to a file that existed before and git doesn’t track, is flagged. Postbox keeps a copy of each file from before, so **Restore** can put it back.
- **Version control:** branches made, commits with their files and lines from git, and pushes.
- **Outside Postbox:** issues, pull requests and comments written with `gh` or a connector, with links.
- **Commands** exactly as they ran, with their exit, duration and all their output, background commands included.
- **Effort:** turns, wall time, tool calls, tokens and spend, by agent, with what they produced, and the turns that left nothing lasting.

It opens in the right pane, beside a thread if one is open, in a compact form: what needs review, files by where they stand, commands and how many failed, what was written outside Postbox, spend, and each turn’s line. Its full-screen icon shows all of the above over the whole window, as a thread’s does for the thread. Under each reply, a line such as “3 files +40 −12 · 2 commands · $0.31” opens the pane at that turn. It’s built from the turn’s tool calls, on Claude Code, the Agent SDK, Codex and Antigravity; Kiro agents’ work isn’t recorded yet ([#555](https://github.com/HJeon139/postbox/issues/555)). Changes a command makes, such as a formatter’s, aren’t seen. Git is only read, without its optional locks, so an agent’s own git never waits on Postbox.

## Run real agents

A persona runs on one of five backends. Pick one in the new-agent sheet, under **Backend**. Three of them can also run on another computer: see “Run agents on a remote host” below.

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

## Run agents on a remote host

An agent’s turns can run on another computer you reach with `ssh`, such as a build machine or a cloud desktop, while Postbox stays on this one (#120). Only the agent’s process moves. The conversation, its cards, the store and Postbox’s API stay here, and Postbox drives the host over an `ssh` it starts itself. Nothing on the host reaches back: no port is opened or forwarded on either machine, and nothing there gets a route to Postbox on this computer. Claude Code, Kiro CLI and Codex can run on a host; the Agent SDK and the Antigravity CLI can’t. The design is in [designs/architecture.md](architecture.md), “Remote hosts”.

**What the host needs**
- **Linux.** Postbox relies on `/proc`, the boot ID and, where logind ends processes at logout, systemd.
- **`ssh` from this computer with no prompt.** Postbox runs your own `ssh` with `BatchMode=yes`, which turns off password and host-key prompts ([ssh_config(5)](https://man.openbsd.org/ssh_config)), so it fails rather than wait. That means a key in your ssh agent or a valid certificate, and the host’s key already in your known hosts. Your `~/.ssh/config` still applies: aliases, `ProxyJump`, certificates and the user. To check, run `ssh -o BatchMode=yes host.example.com true` in a terminal: if it exits without asking anything, Postbox can connect.
- **Node 22 or later there.** Postbox looks on `PATH`, then under `~/.nvm`, `~/.local/share/mise` and `~/.volta`, then in `/usr/local/bin` and `/usr/bin`. For one anywhere else, set **Node’s path** in the host’s settings.
- **The harness, installed and signed in on the host** as your user: `claude` (2.1.187 or later, or 2.1.259 or later with denyPrompts on), `kiro-cli` or `codex`. Postbox looks on `PATH` and in the folders their installers use, such as `~/.local/bin`, and says where it looked when it finds none. Postbox never copies a credential to the host.
- **An ordinary user.** The daemon refuses to run as root.

**Set it up**
1. **Settings → Hosts → Add a host.** Type the SSH destination as you would after `ssh`: an alias from `~/.ssh/config`, a host name, or `user@host.example.com`.
2. **Install…** The confirm says what it writes outside Postbox’s folder, on both computers, and shows the commands `ssh` runs there:
   - Postbox’s host program (`server/remote/host/` and the `shared/` modules it imports) in `~/.postbox-remote/<version>/` on the host, readable only by you (folders `0700`, files `0600`, and the launcher `0700`), each checked against a SHA-256 manifest that comes in the same archive: that catches a broken copy, not a tampered one.
   - The daemon’s token in `~/.postbox-remote/token` there (`0600`), and a copy on this computer in `data/remote-tokens/<host id>` (`0600`), outside what the page reads.
   - With **Node’s path** set, a `node-path` file beside the code that names it.

   Nothing runs as root, and nothing outside `~/.postbox-remote` changes on the host. Postbox connects when a turn there needs it. From then on, the host’s card lists the Node and the harnesses its daemon found, each with its version and path, or where it looked.
3. **Edit settings → Project folders on this host.** Where each project’s agents work there: an absolute path. Left empty, an agent works in `~/postbox-work/<handle>` on the host.
4. **Runs on.** In a persona’s settings, or the new-agent sheet, pick the host under **Runs on**. Its agents run there from their next turn. Postbox refuses a host whose daemon didn’t find that persona’s CLI, and an agent can’t move while a turn of its runs.

**What you see**
- **Where it runs.** The agent’s row and its ring say where it runs and how the connection stands, such as “On host.example.com · Connected · last heard from 2 min ago”. The connection is Connected, Reconnecting, Disconnected (working) when a turn runs there while Postbox can’t reach it, or Disconnected (idle). A dead connection is dropped after about 45 seconds of missed keepalives. Postbox reconnects with backoff while a turn runs there or a prompt waits, and as soon as this computer wakes. The turn goes on on the host meanwhile, and what it wrote arrives on reconnect, each line once.
- **Permission cards** work as they do here. A prompt waits on the host, even while this computer sleeps, for up to the host’s permissionWaitMax, then it’s denied and the card says it expired.
- **Sign-in needed on host.example.com:** the harness’s sign-in on the host ran out (Postbox recognizes Claude Code’s). Sign in there, then press **Resume**. With a signInCheck set, Postbox resumes on its own once the check passes, and warns before a turn when it fails.
- **Interrupted on host.example.com:** the agent’s process there ended without finishing its turn, such as after a reboot. Postbox resumes on its own once the host is back, up to three times in a row, then waits for **Resume**. A resumed Claude Code turn continues the turn that was cut off, and every resumed turn starts with a line telling the agent why.
- **Hung:** “Stopped: no output for 15 min (the last at 14:02)”. A turn with no output for the host’s stallTimeout, no card open and, for Kiro, no tool call open, is stopped. Time while Postbox can’t reach the host doesn’t count.
- **Lost: Postbox can’t reach host.example.com, and the turn may still run there.** Postbox gave up reconnecting during a turn. It attaches to the turn again once the host is back.
- **Stop** goes through the host’s daemon, and the agent reads “Stopping on host.example.com” until the host confirms it. A remote turn’s Stop is always a plain stop: its background jobs stop with it, and when it has any, Stop says so before you press it.
- **A Postbox restart** doesn’t stop a remote turn. The new Postbox finds it running and replays it from the start, replacing the partial reply.
- **The Work view** records the commands, commits, pushes and effort a remote turn’s stream shows. Files on a host aren’t recorded, and it says so.
- **`!` commands** run on this computer, not the host, and their output says so.
- **Kiro CLI** takes its message as a command-line argument, so each remote Kiro turn shows a step saying other users on the host can read it, and a message over 128 KiB is refused before the turn starts.

**The settings worth knowing.** Each host’s **Edit settings** has the full list, with ranges.

| Setting | Default | What it does |
|---|---|---|
| stallTimeout (“Stop a quiet turn after”) | 15 min | How long a turn may go with no output before it’s stopped as hung. Raise it when tools or models stay quiet for longer |
| permissionWaitMax (“Longest wait for a permission answer”) | 24 h | How long a prompt waits on the host before it’s denied |
| denyPrompts | Off | On, Claude Code denies what it would ask about (`--permission-prompts none`) instead of waiting on a card, for unattended runs |
| signInCheck | None | A command that exits 0 while the host’s sign-in is good, one argument per line, run without a shell: such as `klist` and `-s`. With one, a turn stopped for its sign-in resumes once it passes; without one, the turn waits for you |
| idleTimeout (“Daemon’s idle time”) | 30 min | The daemon on the host exits after this long with no turn running and no Postbox connected. Postbox closes its own connection 2 minutes after nothing needs it |
| How turns detach | Own session, and a user scope | “Own session only” for a host without systemd |
| forwardAgent (“Forward your ssh agent”) | Off | Lets turns sign in to other machines with the keys in this computer’s ssh agent |

**Forwarding your ssh agent** doesn’t copy your private keys to the host. But while Postbox is connected, any process running as your user there, including the agent and the commands it runs, can use this computer’s ssh agent to sign in to other machines. So turn it on only for a host you trust that needs it. [ssh_config(5)](https://man.openbsd.org/ssh_config) says the same under ForwardAgent: “Agent forwarding should be enabled with caution. Users with the ability to bypass file permissions on the remote host (for the agent’s Unix-domain socket) can access the local agent through the forwarded connection. An attacker cannot obtain key material from the agent, however they can perform operations on the keys that enable them to authenticate using the identities loaded into the agent.” With **Use a connection of its own** off, Postbox’s session rides your existing shared connection. Agent forwarding still follows this setting for Postbox’s session, but any port forwards that connection opened stay open, and its host key was checked as you opened it.

**Lingering, on systemd hosts.** Where logind kills a user’s processes at logout (`KillUserProcesses`, which “defaults to yes”, per [logind.conf(5)](https://www.freedesktop.org/software/systemd/man/latest/logind.conf.html)), each turn also goes into a systemd user scope, and without lingering that scope ends at your last logout from the host. Postbox’s own connection is one of your sessions while it’s open. When lingering is off there, the host’s card warns, from the first connection, “Turns on host.example.com end when your last session there does” and gives the command, `loginctl enable-linger`, run on the host. Lingering keeps your user manager “around after logouts”, and with no argument it’s for the user who runs it ([loginctl(1)](https://www.freedesktop.org/software/systemd/man/latest/loginctl.html)).

**Remove.** On the host’s card, **Remove…**, then **Remove Postbox from host.example.com**. Postbox stops every turn still running there, has the daemon delete `~/.postbox-remote` on the host (its code, token, logs and turn records), and only then forgets the host here: its settings, its project folders and its token. If the host can’t be reached, doesn’t confirm, or a turn there won’t stop, nothing is forgotten and you can try again. Agents placed on it can’t start a turn until you pick another place for them. Each harness’s own sessions and sign-in on the host stay.

## Narration

Agent apps can read text aloud with `postbox.narration(el, passages)`, a player whose transcript follows the voice, or `postbox.narrate(text)` for one clip. The app needs the `narrate.speak` permission, and its agent the tool.

The voice is [Kokoro](https://github.com/hexgrad/kokoro) (via `kokoro-js`). It runs on this computer in a child process, so its native packages stay out of the server. The model, about 100 MB, downloads into `models/` in the data folder the first time anything is read aloud. After that, a passage takes a second or two, and the same text is never synthesized twice. See the narrated walkthrough in [designs/recipes.md](recipes.md).

## Versions

Postbox uses [semantic versioning](https://semver.org/), from [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/): a breaking change moves the major version, a feature the minor version, and a fix the patch version. The sidebar shows the running build under Personas, as `vX.Y.Z · commit`. Each release is in [CHANGELOG.md](../CHANGELOG.md), and the rules are in [designs/engineering-practices.md](engineering-practices.md), “Commits and versions”.

## Known limits

- **You can’t go back to a build before the `session.patch` event.** Once this version has written to your data folder, a build from before it (v0.44.x and earlier) won’t start: its reducer doesn’t know the `session.patch` event the log now holds, and it replays the log after the snapshot at every start. To run an older build, give it a copy of your data folder from before the upgrade, or a new folder with `--data`. Don’t start it with `--fresh` on your data folder: that deletes every conversation in it.
- **Each open tab holds one connection.** Browsers allow 6 connections per host over HTTP/1.1, so with about six Postbox tabs open, new requests wait. Postbox closes its stream when a tab is put away, but it doesn’t yet share one stream across tabs.
- **The pre-display check is approximate.** It finds overflow, missing labels and alt text, positive tabindex, low contrast and script errors. It doesn’t yet detect every keyboard trap or verify that saved state restores correctly.
- **Semantic search is a stub.** It uses a small table of related words until your own index is connected. Lexical search (BM25) is real.
- **There’s no sign-in.** Postbox is for one person on one machine, and it refuses requests from other hosts and other sites.
- **An attached session has two writers.** If you write to it from Postbox while a terminal turn is still running, both resume the same session. Postbox can’t see that a terminal is busy.
- **Each Claude Code turn starts a new process.** Resuming a session adds a second or two before the first token. A long-lived process per session would remove it.
- **Kokoro’s dependencies have open advisories** (`sharp`, and `sprintf-js` through `onnxruntime-node`) with no fixed versions yet. They run only in the narration process, never in the server.
- **There’s no search across threads yet.**
- **Remote hosts are Linux only.** Postbox needs a Linux host with `/proc`, and relies on the boot ID there. It uses systemd only when **How turns detach** is left on its default (`detach` is `auto`) and logind kills user processes at logout; “Own session only” works without systemd.
- **A Kiro agent’s messages on a host can be read by other users there,** since Kiro CLI takes its message as an argument and `/proc` shows every process’s arguments unless it’s mounted with `hidepid=1` or higher; the default is `0` ([proc(5)](https://man7.org/linux/man-pages/man5/proc.5.html)). Postbox doesn’t check the mount, so it warns on every remote Kiro turn.
- **Files you attach for an agent on a host are limited to 3 MB each and 3.5 MB per message,** since they go to the host with the turn; a message over either is refused before the turn starts. The host’s copy is deleted when the turn ends, so a later turn can’t read it again: attach it again.
- **A host you can’t reach can’t be forgotten yet.** Remove waits for the host to confirm it deleted `~/.postbox-remote`, and there’s no “forget it anyway”.
- **Only Claude Code’s sign-in expiry is recognized on a host.** A Kiro CLI or Codex turn whose sign-in there ran out fails as an ordinary error, not as Sign-in needed with Resume.
- **`!` commands run on this computer,** even in a conversation whose agent runs on a host.
