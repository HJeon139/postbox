# Competitive analysis

This document compares Postbox with the products people would otherwise use to direct several AI agents, get interactive UI from them, and give them structured feedback. It was researched on 21 October 2026 from official docs, changelogs and product pages, with third-party reviews only where official material was missing. Each claim carries a source tag such as [S4]; the sources list at the end gives every URL. Anything marked **unverified** came from a single secondary source or could not be confirmed.

Postbox’s own facts come from its [README](../README.md) and [intent.md](intent.md).

## Summary

- **Nobody else combines the three things Postbox does.** Coding-agent managers (Conductor, Cursor 3, the Codex app, GitHub Agent HQ, Claude Code desktop) run agents in parallel but keep them isolated from each other. Team-chat agents (Claude Tag, Teams channel agents) live in shared rooms but are one agent per room. Chat front ends with multi-agent rooms (LobeHub, Open WebUI channels) use plain models, not coding agents with tool permissions. Postbox puts coding agents in rooms with each other, with interactive blocks and apps, under one person’s supervision.
- **Postbox’s two-tier UI design matches where the industry settled.** A2UI is a catalog of trusted components [S22], and MCP Apps is sandboxed HTML in an iframe talking over `postMessage` [S14]. Postbox has both tiers, but in its own format, so it can’t show third-party MCP app UIs.
- **Postbox is clearly behind on code review.** Every coding-agent manager isolates each task in a git worktree or VM and ends in a diff and a pull request [S1][S2][S4][S9]. Postbox has neither.
- **Its approvals are thinner than the frameworks’.** Postbox offers Allow and Don’t allow. Elsewhere you can edit a tool call’s arguments before approving [S39][S46], make a decision stick for later calls [S43], or route approvals to a reviewer agent that fails closed [S5].

## Postbox, for comparison

Postbox is a local web app for one technical person directing two to four Claude Code or Agent SDK agents. Conversations are direct messages or rooms. In a room, every agent reads what it missed at the start of each turn, and agents wake each other with @-mentions, capped at three wakes in a row before you confirm. Any message can start a topic thread, which forks the agent’s session at that message, and nothing returns to the conversation unless you choose Send to conversation or Summarize back. Agents reply in Markdown plus validated catalog blocks (choice, form, table, progress, card, confirm, image, code, review, app). Anything richer is an agent-written app in a sandboxed iframe with no network access, checked in hidden frames for overflow, labels, contrast and script errors before you see it. The overview shows one column per live session, with status rings and a two-tier “needs you” signal. Permission prompts are cards with Allow and Don’t allow, in four modes per persona. You can attach a terminal Claude Code session, and its terminal turns are mirrored into the thread.

## 1. Multi-agent coding orchestration

### Conductor

**What and who.** A Mac app that runs several Claude Code (and Codex) sessions at once, for developers who want to parallelize work on one repository [S1].

- **Several agents.** Each task is a *workspace* with its own git worktree, branch, terminal, diff and pull-request path [S1]. Its docs say to use separate workspaces for independent tasks, and several chats in one workspace when agents must share a branch [S1].
- **Feedback and approvals.** A Diff Viewer reviews one workspace at a time. A Checks tab tracks git status, CI, deployments, comments and to-dos [S1]. The page doesn’t describe approval prompts.
- **Permissions.** It uses your own Claude Code setup, so commands run with your user permissions unless you configure stricter controls [S1].
- **Layout.** A sidebar of workspaces, each with a chat, a terminal and a diff [S1].
- **Strengths and weaknesses.** Isolation and the path to merge are first-class. Agents don’t talk to each other, and there is no agent-authored UI.

### Cursor 3 Agents Window

**What and who.** An agent-first window added to the Cursor IDE on 2 April 2026 [S2].

- **Several agents.** All local and cloud agents appear in one sidebar, including ones started from mobile, web, Slack, GitHub and Linear [S2]. A session can move from cloud to local to test it, and from local to cloud to keep running while you’re offline [S2]. Agent Tabs show chats side by side or in a grid, `/worktree` isolates an agent, and `/best-of-n` runs one task on several models in separate worktrees for comparison [S3] (third-party).
- **Feedback.** Cloud agents produce demos and screenshots so you can check their work [S2]. A diffs view lets you edit, stage, commit and manage pull requests [S2]. Design Mode lets you pick page elements in the built-in browser and hand the agent their HTML and CSS [S3].
- **Approvals.** The launch post describes none [S2].
- **Strengths and weaknesses.** Handing work between local and cloud, and taking in agents from every surface, is unusually complete. It is built around code, so it has no agent-authored UI beyond the browser preview.

### OpenAI Codex app

**What and who.** A desktop app for running Codex threads in parallel, launched in early February 2026, first on macOS [S4]. It is now documented as part of the ChatGPT desktop app on macOS, Windows and Linux [S6].

- **Several agents.** Threads are grouped by project, and git worktrees let several agents work in one repository without conflicts [S4].
- **Feedback.** A PR review pane brings GitHub reviewer comments, anchored to lines, beside the diff. You can select a comment and ask Codex to address it [S7] (third-party, build 26.415). Scheduled tasks deliver results for review [S6].
- **Permissions.** Sandbox modes are `read-only`, `workspace-write` (the default, with no network) and `danger-full-access`. Approval modes are `on-request`, `never` and granular [S5]. Network access can be limited to an allow and deny list of domains [S5]. Setting `approvals_reviewer = "auto_review"` sends eligible approvals to a reviewer agent, which denies critical-risk actions and fails closed [S5].
- **Strengths and weaknesses.** Codex has the most carefully specified permission model among these products. Its threads don’t share memory or talk to each other, as far as the docs show.

### GitHub Agent HQ and Copilot cloud agent

**What and who.** Announced on 28 October 2025: *mission control*, one place to assign, steer and track agents from several vendors, across GitHub, VS Code, mobile and the CLI [S8].

- **Several agents.** You assign work to a fleet of agents in parallel and can compare how different agents solve the same task [S8].
- **Feedback.** You steer by chatting while a session runs, and the work ends in one pull request per task [S9]. Plan Mode lets you approve a plan before Copilot implements it [S8].
- **Permissions.** These are the strictest of the group. Copilot can only push to `copilot/` branches. It can’t approve or merge its own pull requests. Workflows don’t run until someone with write access clicks **Approve and run workflows**. Internet access goes through a firewall [S10]. Admins set which agents and models are allowed through an enterprise control plane [S8].
- **Strengths and weaknesses.** Its governance and auditability are strong. It runs in the cloud and is tied to GitHub, with a 59-minute session limit [S9].

### Claude Code desktop

**What and who.** Anthropic redesigned it around parallel sessions on 14 April 2026 [S11].

- **Several agents.** A sidebar lists active and recent sessions, filterable by status, project or environment. A session archives itself when its pull request merges or closes [S11].
- **Branching.** **Side chats** (⌘;) branch a question off the running task. They read context from the main thread but add nothing back to it [S11].
- **Layout.** Terminal, preview, diff and chat panes can be dragged into a grid [S11].
- **Strengths and weaknesses.** Side chats are the closest thing in this survey to Postbox’s topic threads, without a way to bring results back.

### Also relevant: Devin and Jules

- **Devin 2.0** (3 April 2025) runs several Devins in parallel, each with its own cloud IDE. *Interactive Planning* returns relevant files and a draft plan within seconds, and you can edit the plan before Devin works alone [S12].
- **Jules** added Interactive Plan and an internal critic agent in August 2025 [S13a]. On 26 January 2026 it added a *Planning Critic* that reviews plans that don’t need human sign-off, which Google says cut task failures by 9.5% [S13].

## 2. Agent-authored interactive UI

### Claude artifacts

**What and who.** Content Claude makes, from documents and decks to small interactive tools, shown in a window beside the conversation and saved to an Artifacts tab [S16].

- **Agent UI.** Artifacts can call Claude as the viewing user, and new artifacts ask permission the first time they do [S16]. They can keep personal or shared storage, up to 20 MB of text [S16]. They can use connected apps after a first-use approval, but connector tools that need approval for every action are excluded [S16].
- **Branching.** Editing an earlier message creates a separate version of the chat with its own artifacts [S16].
- **Layout.** A side window. In a document, you can select text and choose “Edit with Claude” to change only that section [S16].
- **Weaknesses.** The help page doesn’t document network or sandbox limits (**unverified** whether there are any beyond the approvals).

### MCP Apps and the OpenAI Apps SDK

**What.** MCP Apps went live on 26 January 2026 as the first official MCP extension, built on MCP-UI and the OpenAI Apps SDK [S14].

- **Agent UI.** A tool declares a `ui://` resource. The host renders its HTML in a sandboxed iframe and talks to it over JSON-RPC through `postMessage`. The app can call server tools, update the model’s context and send follow-up messages [S14].
- **Safety.** Hosts can review HTML before rendering it, log every message, and require your approval for tool calls the UI starts [S14].
- **Adoption.** Claude, Goose and VS Code Insiders supported it at launch, with ChatGPT rolling it out that week [S14].
- **Layout rules.** OpenAI’s guidelines set three display modes: inline (where every app starts), fullscreen and picture-in-picture. They limit a card to two actions, forbid nested scrolling, and keep the system composer available in fullscreen [S15].

### A2UI

**What.** A Google-led, Apache-licensed protocol in which agents describe UI as declarative JSON. Clients render it with their own widgets from a catalog of trusted components [S22]. Version 0.9.1 is the current production release, and 1.0 is a candidate [S22].

- **Safety.** It sends no code, so there is no code execution and no UI injection [S22].
- **Streaming.** Flat, streaming JSON lets an interface render progressively [S22].

### Front-end toolkits: AI SDK, CopilotKit, assistant-ui

- **Vercel AI SDK.** Tool calls render as typed message parts mapped to React components [S19]. Each part moves through `input-streaming`, `input-available`, `approval-requested`, `approval-responded`, `output-available`, `output-error` and `output-denied` [S20]. Approvals can be manual or automatic, and `experimental_toolApprovalSecret` lets the server check that it issued an approval [S20].
- **CopilotKit.** `useHumanInTheLoop` pauses the agent until your UI calls `respond`, through the states InProgress, Executing and Complete [S21].
- **assistant-ui.** `makeAssistantToolUI` renders tool calls as components. The approval logic now lives in toolkits [S23] (search summary, **unverified** in detail).

### Canvas-style editors: ChatGPT Canvas, Gemini Canvas, v0

- **ChatGPT Canvas** works like a copy editor or code reviewer. You highlight a section to focus the model, and shortcuts include review code, add logs and fix bugs [S17].
- **Gemini Canvas** generates HTML and React prototypes with a live preview that refreshes as you ask for changes [S18].
- **v0** reportedly added a VS Code-style editor, sandboxed previews and a richer Design Mode in 2026 (**unverified**: third-party sources only [S24]).

These are single-agent editors. They are relevant to Postbox’s review block, not to supervising several agents.

## 3. Team chat with agents

### Claude Tag (Claude in Slack)

**What and who.** Claude in Slack channels as the organization’s shared identity, with admin-governed access. It is in public beta on Team and Enterprise plans [S25].

- **Several agents and supervision.** One agent identity. Each thread binds to its own session and sandbox. A channel also has its own session for top-level messages, and two threads never share state directly [S26]. Anyone in the thread can steer by replying, and **Stop** keeps the session [S26].
- **Progress.** Longer tasks get a checklist that Claude edits in place. The docs warn that Slack doesn’t notify on edits, so a quiet thread usually means work in progress [S26].
- **Memory.** Memory is a set of curated notes per channel, plus workspace notes saved from public channels. Anyone can ask “what do you remember about this channel?” and correct it [S27]. Claude can list and read past sessions in a channel, but can’t search their full text [S27].
- **Permissions.** Access is set per channel. A thread locks in its skills and instructions when it starts, while connectors are checked on every request [S26]. Posts outside the conversation carry an attribution line, and from a DM each one needs **Approve and post** [S26].
- **Safety.** The earlier Claude Code in Slack warned that Claude “may follow directions from other messages in the context” [S28].
- **Strengths and weaknesses.** Its scoping of memory, access and sessions is the clearest in this survey. It has one agent, and no interactive blocks beyond Slack messages and hosted pages [S26].

### Slack’s agent platform and Agentforce

- **Agent surfaces.** Agents get a split-view side panel and a top-bar entry. Their conversations are assistant threads with suggested prompts [S29].
- **Status and context.** Apps call `agents.sessions.setStatus` for a loading state, which times out after an hour, and get a Stop button if they subscribe to `agent_session_stopped`. They receive `app_context_changed` with what the user is looking at [S29].
- **Agentforce in Slack.** You add an agent to a channel and @-mention it. It uses the asking user’s Slack and Salesforce permissions [S30] (search summary).

### Microsoft Teams channel agent

- **What it does.** Every channel can have an agent that reasons over the channel’s conversations, Planner boards and meeting content. You address it as `@<channel name> agent`, and its replies are visible to all members [S31].
- **Limits.** It needs a Copilot license, and it doesn’t respond when guests or external members are present, which one reviewer calls a “deal breaker” [S31]. From January 2026, new channels get a channel agent automatically [S32] (third-party).

### Discord bots

There is no platform-level agent model. Agent frameworks set their own rules. For example, Hermes Agent replies only when mentioned, creates a thread per mention, keeps each thread’s history separate from its channel, and gives each user their own session by default. It asks for command approvals with buttons [S33].

## 4. Open-source chat front ends

### Open WebUI

- **Several models.** **Compare** sends one prompt to several models in side-by-side columns. An experimental **Merge Responses** has one model combine the drafts [S34]. Admins can turn multi-model chat on or off per group [S34].
- **Rooms.** *Channels* put people and models in one timeline. Models reply only when @-mentioned, in a thread by default. With native function calling, they can search channels and read whole threads [S35].
- **Permissions.** MCP support is native over Streamable HTTP. Adding MCP servers is limited to admins, because a malicious server could run code with the user’s access [S36] (search summary).
- **Strengths and weaknesses.** It handles many models and many users. Its models are chat models, not coding agents with file and command permissions.

### LibreChat

- **Branching.** *Fork* copies a conversation from any message into a new chat. Options cover only the visible path, related branches, or everything to and from the message [S37].
- **Agent UI.** Artifacts (React, HTML, SVG, Mermaid, Markdown) render in a side panel you can pop out into its own window [S38]. React and HTML run through CodeSandbox’s Sandpack, which by default loads from a public CDN that may send telemetry [S38].
- **Several agents.** Agent Chain (up to 10 agents, in beta), handoffs, and subagents with isolated context [S39].
- **Approvals.** An **Ask User** tool collects up to four questions per call. Admins can require review before matching tool calls run, where you can approve, reject, *edit the arguments*, or answer directly. Paused runs are checkpointed [S39]. Agents are shared through access-control lists with Viewer, Editor and Owner roles [S39].

### LobeHub (formerly LobeChat)

- **Several agents.** Version 2.0 (27 January 2026) made multi-agent group chat its headline feature [S40]. In the RFC, a supervisor model picks who speaks next and whether a reply is public or a DM between agents. The config includes `maxResponseInRow`, and agent messages are limited to 100 words [S41].
- **Branching.** Create Branch on any message, in *continuation* mode (keeps the context) or *standalone* mode (a fresh topic) [S42] (changelog, version range unclear).
- **Weaknesses.** Users don’t control who speaks next; the supervisor’s model does [S41].

## 5. Agent dev and observability studios

### LangGraph and LangSmith Studio, with Agent Inbox

- **Studio.** Graph mode shows the nodes traversed and the intermediate states. Chat mode is for testing behavior. Both support time-travel debugging [S43a].
- **Interrupts.** `interrupt()` pauses anywhere in a node and waits indefinitely, persisted by a checkpointer and keyed by `thread_id`. `Command(resume=...)` continues the run, and parallel interrupts resume together [S44].
- **Branching.** Time travel replays from a checkpoint, or *forks* it with `update_state`, leaving the original history intact [S45].
- **Agent Inbox.** An inbox for interrupts across graphs. Each interrupt declares which responses are allowed: accept, edit, respond or ignore [S46].

### OpenAI Agents SDK

- **Approvals.** Tools set `needs_approval`, either as a boolean or as a function that fails closed when it can’t inspect the arguments [S43]. Pending approvals come back as `result.interruptions`. You can `approve` or `reject` them, with a message, and mark a decision `always_approve` or `always_reject` [S43].
- **Resuming later.** Runs serialize with `state.to_json()` to resume later. The docs warn that snapshots aren’t authenticated, so reviewers must be authorized and each decision consumed once [S43].
- **Tracing.** On by default, it covers agent runs, generations, tool calls, handoffs and guardrails, with controls for sensitive data and third-party exporters [S47].

### CrewAI

- **Feedback in flows.** `@human_feedback` pauses a flow for review. With `emit`, a model turns your free-form feedback into one of several named outcomes, so revision loops end in approved or rejected [S48].
- **Hosted runs.** On AMP, runs pause in *Pending Human Input* until a webhook-driven resume. Your feedback becomes context for later tasks [S49].

### AutoGen Studio and Microsoft Agent Framework

- **AutoGen.** The README says AutoGen is archived and no longer maintained by Microsoft. AutoGen Studio is a no-code prototyping UI, not meant for production [S50].
- **DevUI.** Microsoft Agent Framework’s DevUI is likewise a sample app. It builds input forms from a workflow’s schema and includes OpenTelemetry tracing [S51] (search summary).

## Comparison matrix

“Not documented” means the sources reviewed didn’t cover it, not that the feature is absent.

| Product | Several agents and supervision | Agent-authored UI | Structured feedback and approvals | Branching, memory, context | Permissions and safety | Layout |
|---|---|---|---|---|---|---|
| **Postbox** | Rooms of 2–4 agents with shared context; @-wakes capped at 3 in a row; overview columns with status rings and two tiers of “needs you” | Validated catalog blocks plus sandboxed apps with no network, checked before display | choice, form, confirm, and review with line comments and diffs; permission cards with Allow and Don’t allow | Topic thread = forked session; Send to conversation and Summarize back; compaction dividers | 4 modes per persona; local only; no API key held | Rail, conversation, thread panel, overview |
| Conductor | Workspace per task, each a worktree [S1] | None | Diff Viewer, Checks tab [S1] | Several chats in one workspace share a branch [S1] | Your own Claude Code permissions [S1] | Workspace sidebar, chat, terminal, diff |
| Cursor 3 | Sidebar of local and cloud agents from every surface; best-of-N [S2][S3] | Browser preview; Design Mode [S3] | Diffs view; demo and screenshot evidence [S2] | Local ↔ cloud handoff [S2] | Not documented in the launch post | Agents Window, tabs or grid [S3] |
| Codex app | Parallel threads per project, worktrees [S4] | Artifact viewer [S7] | PR review pane with line comments [S7] | Not documented | Sandbox and approval modes; domain allow list; auto-review [S5] | Threads plus review pane |
| Agent HQ / Copilot | Mission control across vendors [S8] | None | Plan Mode; PR review [S8][S9] | One PR per task [S9] | Agent-only branches; workflow approval; firewall [S10] | Agents panel on web, VS Code, mobile, CLI |
| Claude Code desktop | Session sidebar with status filters [S11] | Preview pane [S11] | Not documented | Side chats read the parent, add nothing back [S11] | Not documented in the article | Draggable pane grid [S11] |
| Claude artifacts | One assistant | Side-window apps; can call Claude; storage [S16] | “Edit with Claude” on a selection [S16] | Editing a message forks the chat [S16] | First-use approvals for Claude and connectors [S16] | Chat plus side window |
| MCP Apps / ChatGPT apps | Not applicable | Sandboxed iframe over JSON-RPC [S14] | App sends follow-ups and calls tools [S14] | App can update model context [S14] | Host review and approval of UI-started tool calls [S14] | Inline, fullscreen, picture-in-picture [S15] |
| A2UI | Not applicable | Declarative catalog, no code [S22] | Client-to-server actions in 1.0 candidate [S22] | Not applicable | No code execution [S22] | Native renderers [S22] |
| AI SDK / CopilotKit | Not applicable | Tool parts rendered as components [S19][S21] | Typed approval states; respond callback [S20][S21] | Not applicable | Server-verified approvals [S20] | Developer-defined |
| Claude Tag | One identity; session per thread [S26] | Messages, files, hosted pages [S26] | Live checklist; Approve and post [S26] | Curated channel and workspace notes you can correct [S27] | Access per channel; attribution lines [S26] | Slack threads |
| Teams channel agent | One agent per channel [S31] | Loop status reports [S31] | Not documented | Channel, Planner and meeting content [S31] | License-gated; silent with guests [S31] | Teams channel |
| Open WebUI | Compare and merge models; models in channels [S34][S35] | Not documented here | Not documented | Channels search and read threads [S35] | MCP limited to admins; group permissions [S34][S36] | Columns; channel threads |
| LibreChat | Chains, handoffs, subagents [S39] | Side-panel artifacts, can pop out [S38] | Ask User; approve, reject or edit arguments [S39] | Fork from any message [S37] | Access lists per agent [S39] | Chat plus artifact panel |
| LobeHub | Supervisor-run group chat; agent DMs [S41] | Not documented here | Not documented | Continuation and standalone branches [S42] | Not documented | Group chat |
| LangGraph Studio + Agent Inbox | Assistants and threads [S43a] | Not applicable | Accept, edit, respond, ignore [S46] | Time-travel fork at a checkpoint [S45] | Not applicable | Graph and chat modes; inbox |
| OpenAI Agents SDK | Handoffs; agents as tools [S43] | Not applicable | Interruptions; sticky decisions [S43] | Serializable run state [S43] | Fails closed; authorized resume [S43] | Traces dashboard [S47] |

## Patterns worth learning from

1. **One isolated workspace per task, ending in a diff.** Conductor, Cursor, Codex and Copilot all give each task its own worktree, VM or branch, and all end in a reviewable diff and a pull request [S1][S3][S4][S10]. *Why it works:* parallel agents can’t trample each other, and “done” has a concrete form you can review. Postbox’s room agents share the project’s root folder (README), so two agents editing at once can collide, and nothing shows what an agent changed on disk.

2. **Approvals with more than two answers.** Agent Inbox lets each interrupt declare accept, edit, respond or ignore [S46]. LibreChat lets you edit a tool call’s arguments before approving it [S39]. The OpenAI Agents SDK makes decisions sticky with `always_approve` [S43]. *Why it works:* “yes, but change this flag” is the most common real answer, and doing it in one step avoids a deny-then-explain turn. Postbox’s card has two answers.

3. **An automatic reviewer that fails closed.** Codex’s `auto_review` only sees actions that already need approval, denies critical-risk ones, and fails closed on errors [S5]. Jules’s Planning Critic reviews plans that don’t need human sign-off [S13]. *Why it works:* it cuts interruptions without widening the sandbox. Postbox’s Auto mode already relies on Claude Code’s classifier. The lesson is to state the fail-closed rule and to show what the reviewer decided.

4. **Approve the plan before the work.** Devin returns a draft plan you can edit within seconds [S12], Jules has Interactive Plan [S13a], and Copilot has Plan Mode [S8]. *Why it works:* fixing the approach is cheap, and fixing the code is not. Postbox has the parts (review, choice, confirm) but no plan step, so it depends on each agent’s prompt.

5. **Side branches that read the parent but don’t write back.** Claude Code desktop’s side chats do exactly this [S11]. LangGraph forks keep the original history intact [S45]. LobeHub separates continuation from standalone branches [S42]. *Why it works:* this confirms Postbox’s core memory idea. Postbox goes further with Summarize back. LobeHub’s standalone mode (branch with no history) is a variant worth considering.

6. **Memory as notes you can read and correct, scoped to a place.** Claude Tag keeps short notes per channel and per workspace. Anyone can ask what it remembers and correct it, and the docs advise against turning memory into a running log [S27]. *Why it works:* memory becomes visible and fixable instead of hidden in a session. Postbox’s memory is the session itself: compaction dividers show what was kept, but nothing persists a room’s conventions across sessions.

7. **Progress edited in place, with honest silence.** Claude Tag’s first reply to a long task is a checklist it edits as it goes, and its docs say a quiet thread usually means work, not a stall [S26]. Slack’s status API times out after an hour [S29]. *Why it works:* one living object beats a stream of status messages. Postbox’s progress block with `update_block` is the same pattern. Slack’s timeout suggests Postbox should also treat a status that hasn’t changed for a long time as possibly stuck.

8. **Strict rules for embedded apps.** OpenAI’s guidelines set three display modes, at most two actions per card, no nested scrolling, and a composer that stays available in fullscreen [S15]. *Why it works:* embedded apps can’t take over the conversation. Postbox has inline display and Expand. A picture-in-picture mode would fit its narration player, and the no-nested-scroll rule could join the pre-display check.

9. **Typed states for every tool call.** The AI SDK’s parts move from `input-streaming` through `approval-requested` to `output-denied` [S20], and CopilotKit uses InProgress, Executing and Complete [S21]. *Why it works:* the UI can show exactly where a call is and never shows half a form. This matches Postbox’s rule that a block appears only once its JSON is complete.

10. **Standard formats for agent UI.** MCP Apps (`ui://`, a sandboxed iframe, JSON-RPC over `postMessage`, host approval of UI-started tool calls) has been supported by Claude, ChatGPT, Goose and VS Code since early 2026 [S14]. A2UI standardizes the catalog approach [S22]. *Why it works:* one UI runs in every host. Postbox’s `show_app` and kit bridge are close to MCP Apps in shape but not compatible with it.

11. **Compare agents on the same task.** Open WebUI runs Compare and Merge Responses [S34], Cursor has `/best-of-n` [S3], and Agent HQ lets you see how different agents solve the same task [S8]. *Why it works:* when a task is uncertain, comparing outputs beats prompting one agent repeatedly. Postbox rooms would suit this, but it isn’t a built-in flow.

12. **One list of everything, from every surface.** Cursor’s sidebar includes agents started from Slack, GitHub, Linear and mobile, and moves sessions between local and cloud [S2]. Agent HQ’s mission control follows you across web, VS Code, mobile and CLI [S8]. *Why it works:* supervision shouldn’t depend on which window you started in. Postbox’s attached terminal sessions are a step in this direction, while everything else runs on one machine.

## Where Postbox is differentiated

- **Coding agents that share a room.** Among the products reviewed, the coding-agent managers keep agents isolated: one agent per worktree or thread, and agents don’t message each other [S1][S4][S9][S11]. The products with multi-agent rooms (LobeHub [S41], Open WebUI channels [S35]) run chat models without per-agent file and command permissions. Claude Tag has rooms but one agent [S26]. Postbox combines agents with tool permissions, shared room context, agent-to-agent wakes with a cap, and side threads between agents. No other product reviewed has all four.
- **Forks you can bring back.** Claude Code side chats read the parent but can’t send anything back [S11]. LibreChat forks copy messages into a separate chat [S37]. LangGraph forks are a developer tool [S45]. Postbox forks the real agent session at a message, opens it beside the conversation, and lets you bring back a reply or a summary without costing the main agents a turn. No product reviewed offers that full round trip.
- **Both tiers of UI, plus quality checks.** A2UI offers only the catalog [S22], and MCP Apps and Claude artifacts only sandboxed HTML [S14][S16]. Postbox has both, with versioning and a plain-text fallback for every block. Its pre-display check (overflow at two widths, missing labels, contrast, script errors, with failures sent back to the agent) has no equivalent in the sources: OpenAI’s guidelines ask for WCAG AA but leave it to developers [S15].
- **Review on more than code.** Codex reviews pull-request comments on code [S7], and Canvas reviews text and code [S17]. Postbox’s review block covers Markdown, code, and agent-written apps through registered anchors, and shows the revision as a diff.
- **Local, private and keyless.** Apps have no network access, and Postbox never holds an API key. By contrast, LibreChat’s artifacts load from CodeSandbox’s public CDN by default [S38], and most coding-agent managers run in the cloud [S2][S9]. Open WebUI and LibreChat are also self-hostable, so “local” alone isn’t unique; local plus coding agents plus sandboxed apps is.
- **Linting what agents write.** The undefined-term and diagram-legibility linters, which report problems back to the agent, had no counterpart in any source reviewed. Neither did local narration. These searches were not exhaustive, so treat both as **unverified** differentiators.

## Where Postbox is behind

- **Code changes.** It has no worktree isolation, no diff of what an agent changed on disk, no checks view, and no pull-request flow. Every coding competitor has these [S1][S2][S4][S9]. For a tool whose agents are Claude Code sessions, this is the largest gap.
- **Approval depth.** You can’t edit arguments, set a decision that sticks per tool, or see an auditable reviewer verdict (compare [S5][S39][S43][S46]). Postbox’s README documents only Allow and Don’t allow. Whether Claude Code’s own “always allow” rules apply through the card is **unverified** from Postbox’s docs.
- **Memory that lasts.** It has no curated per-room notes that persist across sessions (compare [S27]) and, by design, no search across threads. Claude Tag can at least list and read past sessions [S27], and Open WebUI agents can search channels [S35].
- **Where it runs.** It runs on one machine with no cloud handoff, mobile view of running agents, or entry from chat tools (compare [S2][S8]). Postbox has a phone layout, but only on the same local server.
- **Backends.** It supports only Claude Code and the Agent SDK, plus a mock. Agent HQ hosts agents from several vendors [S8], Open WebUI and LibreChat accept many models, and Conductor runs Codex as well as Claude Code [S1]. Postbox’s adapter interface makes this fixable, but it isn’t done.
- **Standards.** Its blocks and apps use its own format. It can’t show UIs from MCP Apps servers, which Claude and ChatGPT both render [S14], and its agents’ apps can’t run in those hosts.
- **Planning and comparison.** It has no plan-approval step (compare [S8][S12][S13a]) and no built-in way to run one task on several agents and compare the results (compare [S3][S34]).
- **Observability.** Activity lines and rings show live work, but there is no trace view or export like the OpenAI Agents SDK’s tracing [S47], LangSmith Studio [S43a] or DevUI’s OpenTelemetry [S51].
- **Deliberate limits.** It is built for one person, with no sign-in and no OS notifications. Claude Tag [S26], Teams [S31] and Open WebUI [S35] are built for teams. This is a choice in [intent.md](intent.md), not an oversight, but it rules out shared rooms.

## Sources

All sources were accessed on 21 October 2026. Publication dates are given where the source states one.

- **S1** · Conductor, “Run multiple Claude Code sessions” (docs, undated) · <https://www.conductor.build/docs/guides/parallel-agents/run-multiple-claude-code-sessions>
- **S2** · Cursor, “Cursor 3” (blog, 2 April 2026) · <https://cursor.com/blog/cursor-3>
- **S3** · DataCamp, “Cursor 3” (third-party review, 8 April 2026) · <https://www.datacamp.com/blog/cursor-3>
- **S4** · heise online, on the Codex app (4 February 2026) · <https://heise.de/-11165126>
- **S5** · OpenAI, “Agent approvals and security” (Codex docs, undated) · <https://learn.chatgpt.com/docs/agent-approvals-security>
- **S6** · OpenAI, ChatGPT desktop app and Codex docs index (undated) · <https://learn.chatgpt.com/docs/app>
- **S7** · Daniel Vaughan, “Inside the Codex App Workspace” (third-party, 17 April 2026, updated 21 October 2026) · <https://codex.danielvaughan.com/2026/04/17/codex-app-workspace-pr-review-task-sidebar-artifact-viewer/>
- **S8** · GitHub, “Welcome home, agents” (blog, 28 October 2025) · <https://github.blog/news-insights/company-news/welcome-home-agents/>
- **S9** · GitHub Docs, “About Copilot coding agent” · <https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent>
- **S10** · GitHub Docs, “Risks and mitigations for GitHub Copilot cloud agent” · <https://docs.github.com/en/copilot/concepts/agents/cloud-agent/risks-and-mitigations>
- **S11** · Anthropic, “Redesigning Claude Code on desktop for parallel agents” (14 April 2026) · <https://claude.com/resources/articles/claude-code-desktop-redesign>
- **S12** · Cognition, “Devin 2.0” (3 April 2025) · <https://cognition.com/blog/devin-2>
- **S13** · Jules changelog, Planning Critic (26 January 2026) · <https://jules.google/docs/changelog/2026-01-26-1>
- **S13a** · Jules changelog, Interactive Plan and critic (8 August 2025; read through a search summary) · <https://jules.google/docs/changelog/2025-08-082>
- **S14** · MCP blog, “MCP Apps” (26 January 2026) · <https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/>
- **S15** · OpenAI, Apps SDK “UI guidelines” · <https://developers.openai.com/apps-sdk/concepts/ui-guidelines>
- **S16** · Claude Help Center, artifacts article · <https://support.claude.com/en/articles/9487310>
- **S17** · OpenAI, “Introducing canvas” (read through a search summary) · <https://openai.com/index/introducing-canvas/>
- **S18** · TechCrunch, “Google brings a canvas feature to Gemini” (18 March 2025) · <https://techcrunch.com/2025/03/18/google-brings-a-canvas-feature-to-gemini-plus-audio-overview/>
- **S19** · AI SDK, “Generative user interfaces” · <https://ai-sdk.dev/docs/ai-sdk-ui/generative-user-interfaces>
- **S20** · AI SDK, “Chatbot tool usage” · <https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-tool-usage>
- **S21** · CopilotKit, `useHumanInTheLoop` reference · <https://docs.copilotkit.ai/reference/hooks/useHumanInTheLoop>
- **S22** · A2UI project site · <https://a2ui.org/>
- **S23** · assistant-ui, `makeAssistantToolUI` (read through a search summary) · <https://www.assistant-ui.com/docs/copilots/make-assistant-tool-ui>
- **S24** · SaaStr, “AI app of the week: v0 by Vercel” (third-party) · <https://www.saastr.com/saastr-ai-app-of-the-week-v0-by-vercel-the-vibe-coding-tool-that-4-million-people-use-to-ship-real-software-not-just-demos>
- **S25** · Claude docs, “Work with Claude Tag” (public beta) · <https://claude.com/docs/claude-tag/overview>
- **S26** · Claude docs, “How Claude Tag works” · <https://claude.com/docs/claude-tag/concepts/how-it-works>
- **S27** · Claude docs, “What Claude Tag remembers” · <https://claude.com/docs/claude-tag/users/memory>
- **S28** · Claude Code docs, “Claude Code in Slack” · <https://code.claude.com/docs/en/slack>
- **S29** · Slack developer docs, “Agent entry and interaction” · <https://docs.slack.dev/ai/agent-entry-and-interaction>
- **S30** · Slack Help Center, “Use Agentforce in Slack” (read through a search summary) · <https://slack.com/help/articles/36218786859667-Use-Agentforce-in-Slack>
- **S31** · Office 365 for IT Pros, “Teams channel agent” (12 January 2026) · <https://office365itpros.com/2026/01/12/teams-channel-agent/>
- **S32** · isolutions, “The new Channel Agent” (third-party) · <https://www.isolutions.ch/en/news/the-new-channel-agent/>
- **S33** · Nous Research, Hermes Agent Discord guide · <https://hermes-agent.nousresearch.com/docs/user-guide/messaging/discord>
- **S34** · Open WebUI docs, “Multi-model chats” · <https://docs.openwebui.com/features/chat-conversations/chat-features/multi-model-chats>
- **S35** · Open WebUI docs, “Channels” · <https://docs.openwebui.com/features/channels>
- **S36** · Open WebUI docs, “Model Context Protocol” (read through a search summary) · <https://docs.openwebui.com/features/extensibility/mcp>
- **S37** · LibreChat docs, “Fork” · <https://www.librechat.ai/docs/features/fork>
- **S38** · LibreChat docs, “Artifacts” · <https://www.librechat.ai/docs/features/artifacts>
- **S39** · LibreChat docs, “Agents” · <https://www.librechat.ai/docs/features/agents>
- **S40** · LobeHub changelog, v2.0 (27 January 2026; the page body was empty when fetched, so the date comes from the URL and search results) · <https://lobehub.com/changelog/2026-01-27-v2>
- **S41** · LobeHub, “RFC 130: Multi-agent orchestration (group chat)” (25 August 2025) · <https://lobehub.com/blog/rfc-130>
- **S42** · LobeHub changelog, “Branching conversations” (read through a search summary) · <https://lobehub.com/fr/changelog/page/3>
- **S43** · OpenAI Agents SDK (Python), “Human in the loop” · <https://openai.github.io/openai-agents-python/human_in_the_loop/>
- **S43a** · LangSmith docs, “Studio” · <https://docs.langchain.com/langsmith/studio>
- **S44** · LangGraph docs, “Interrupts” · <https://docs.langchain.com/oss/python/langgraph/interrupts>
- **S45** · LangGraph docs, “Use time travel” · <https://docs.langchain.com/oss/python/langgraph/use-time-travel>
- **S46** · LangChain, Agent Inbox repository · <https://github.com/langchain-ai/agent-inbox>
- **S47** · OpenAI Agents SDK (Python), “Tracing” · <https://openai.github.io/openai-agents-python/tracing/>
- **S48** · CrewAI docs, “Human feedback in flows” · <https://docs.crewai.com/learn/human-feedback-in-flows>
- **S49** · CrewAI docs, “Human-in-the-loop” · <https://docs.crewai.com/learn/human-in-the-loop>
- **S50** · Microsoft, AutoGen repository README · <https://github.com/microsoft/autogen>
- **S51** · Microsoft Learn, “DevUI” for Agent Framework (read through a search summary) · <https://learn.microsoft.com/en-us/agent-framework/devui>

[S1]: https://www.conductor.build/docs/guides/parallel-agents/run-multiple-claude-code-sessions
[S2]: https://cursor.com/blog/cursor-3
[S3]: https://www.datacamp.com/blog/cursor-3
[S4]: https://heise.de/-11165126
[S5]: https://learn.chatgpt.com/docs/agent-approvals-security
[S6]: https://learn.chatgpt.com/docs/app
[S7]: https://codex.danielvaughan.com/2026/04/17/codex-app-workspace-pr-review-task-sidebar-artifact-viewer/
[S8]: https://github.blog/news-insights/company-news/welcome-home-agents/
[S9]: https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent
[S10]: https://docs.github.com/en/copilot/concepts/agents/cloud-agent/risks-and-mitigations
[S11]: https://claude.com/resources/articles/claude-code-desktop-redesign
[S12]: https://cognition.com/blog/devin-2
[S13]: https://jules.google/docs/changelog/2026-01-26-1
[S13a]: https://jules.google/docs/changelog/2025-08-082
[S14]: https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/
[S15]: https://developers.openai.com/apps-sdk/concepts/ui-guidelines
[S16]: https://support.claude.com/en/articles/9487310
[S17]: https://openai.com/index/introducing-canvas/
[S18]: https://techcrunch.com/2025/03/18/google-brings-a-canvas-feature-to-gemini-plus-audio-overview/
[S19]: https://ai-sdk.dev/docs/ai-sdk-ui/generative-user-interfaces
[S20]: https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-tool-usage
[S21]: https://docs.copilotkit.ai/reference/hooks/useHumanInTheLoop
[S22]: https://a2ui.org/
[S23]: https://www.assistant-ui.com/docs/copilots/make-assistant-tool-ui
[S24]: https://www.saastr.com/saastr-ai-app-of-the-week-v0-by-vercel-the-vibe-coding-tool-that-4-million-people-use-to-ship-real-software-not-just-demos
[S25]: https://claude.com/docs/claude-tag/overview
[S26]: https://claude.com/docs/claude-tag/concepts/how-it-works
[S27]: https://claude.com/docs/claude-tag/users/memory
[S28]: https://code.claude.com/docs/en/slack
[S29]: https://docs.slack.dev/ai/agent-entry-and-interaction
[S30]: https://slack.com/help/articles/36218786859667-Use-Agentforce-in-Slack
[S31]: https://office365itpros.com/2026/01/12/teams-channel-agent/
[S32]: https://www.isolutions.ch/en/news/the-new-channel-agent/
[S33]: https://hermes-agent.nousresearch.com/docs/user-guide/messaging/discord
[S34]: https://docs.openwebui.com/features/chat-conversations/chat-features/multi-model-chats
[S35]: https://docs.openwebui.com/features/channels
[S36]: https://docs.openwebui.com/features/extensibility/mcp
[S37]: https://www.librechat.ai/docs/features/fork
[S38]: https://www.librechat.ai/docs/features/artifacts
[S39]: https://www.librechat.ai/docs/features/agents
[S40]: https://lobehub.com/changelog/2026-01-27-v2
[S41]: https://lobehub.com/blog/rfc-130
[S42]: https://lobehub.com/fr/changelog/page/3
[S43]: https://openai.github.io/openai-agents-python/human_in_the_loop/
[S43a]: https://docs.langchain.com/langsmith/studio
[S44]: https://docs.langchain.com/oss/python/langgraph/interrupts
[S45]: https://docs.langchain.com/oss/python/langgraph/use-time-travel
[S46]: https://github.com/langchain-ai/agent-inbox
[S47]: https://openai.github.io/openai-agents-python/tracing/
[S48]: https://docs.crewai.com/learn/human-feedback-in-flows
[S49]: https://docs.crewai.com/learn/human-in-the-loop
[S50]: https://github.com/microsoft/autogen
[S51]: https://learn.microsoft.com/en-us/agent-framework/devui
