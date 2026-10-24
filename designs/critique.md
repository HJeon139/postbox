# Product critique

A critique of Postbox’s interface layout and its end-to-end experience, written on 21 October 2026 after the first full user acceptance test. It uses three kinds of evidence:
- **The product itself:** the component screenshots in [`tests/uat/screenshots/`](../tests/uat/screenshots/), the code (with file references), and live runs with real Claude Code agents.
- **The competitive analysis:** [competitive-analysis.md](competitive-analysis.md). Source tags such as [S11] refer to its sources list.
- **Postbox’s own stated intent:** [intent.md](intent.md), whose principles are the bar to judge against.

Each point says what was observed, why it matters, and what to change. Points are ranked by impact on the core job. That job, in intent.md’s words, is one person directing several agents that reply with software they write, where conversations manage what each agent remembers. Every recommendation is filed as a GitHub issue labeled `critique`; the table at the end links them.

## Part 1: layout and interface design

### 1.1 The overview spends most of its space on nothing

**Observed.** With 12 live sessions, the overview is about 1,930 px tall at 1280 px wide (screenshot: [overview.png](../tests/uat/screenshots/overview.png)). Each card is 560–770 px tall. On idle cards, roughly half of that height is fixed sections that say “None” (agent messages, subagents) or repeat the header: “Current step: Idle since 09:50” under a header that already says “Idle since 09:50”. Idle cards are as tall as the four that need you, so the second row of the grid is all idle sessions.

**Why it matters.** Intent.md describes dispatch mode: several agents work in the background, and you check progress and answer when one is blocked. The overview exists for that glance. When most of the screen is empty sections, the eye has to search, and the four columns that matter compete with eight that don’t. Competitors that supervise many agents compress idle ones to a row in a list: Claude Code desktop’s sidebar filters by status [S11], and Cursor’s Agents Window lists every agent in one sidebar [S2]. Principle 3 in intent.md, “calm by default; draw the eye only when it matters”, argues the same way.

**Recommendation.** Hide sections with nothing in them. Fold the current step into the header when it only repeats the state. Collapse idle sessions into one compact row each (ring, name, conversation, last message), below the sessions that need you or are working.

### 1.2 Words in the new-agent sheet contradict the rest of the app

**Observed.** The new-agent sheet still offers “Join this thread” and “New thread in Book corpus”, and says the conversation “becomes a room” (screenshot: [new-agent-sheet.png](../tests/uat/screenshots/new-agent-sheet.png)). Everywhere else, the app now calls these *conversations*, and *thread* means a topic thread off a message. Overview cards also say “Open thread” for what opens a conversation ([overview-card.png](../tests/uat/screenshots/overview-card.png)).

**Why it matters.** Postbox now has two things a reader could call a thread. When the same word names both, people can’t predict what a control will do. That matters most in the sheet that decides where a new agent lands.

**Recommendation.** Use “conversation” for direct messages and rooms in every string, and “thread” only for topic and side threads. A copy lint for “thread” in these files would keep it from coming back.

### 1.3 The Tools checklist promises control it doesn’t have

**Observed.** The new-agent sheet and the persona editor list tools with checkboxes, including `shell` (“Run commands in the project folder”) and `web.fetch`. For Claude Code and Agent SDK agents, these settings only govern what the agent’s *apps* may query: `appQuery` in [`server/runtime.mjs`](../server/runtime.mjs) is their only consumer, besides highlighting proposals. They aren’t passed to the CLI or the SDK. An agent with `shell` unticked can still run commands; only its permission mode governs that.

**Why it matters.** This is a safety affordance that does nothing. Someone who unticks `shell` to keep an agent from running commands is misled, which is worse than having no checkbox. Principle 6 in intent.md is “tools are granted explicitly”. The competitors with the strongest permission models make the grant real: Codex’s sandbox and approval modes are enforced by the runtime [S5], and Copilot is confined to its own branches [S10].

**Recommendation.** Either enforce the list for real backends (map it to `--allowedTools` and `--disallowedTools` and to the SDK’s `allowedTools`), or rename the section “What its apps can use” and drop the entries that don’t apply. Enforcing is better.

### 1.4 The top bar will run out of room in a full room

**Observed.** In a two-agent room, the 1280 px top bar holds the sidebar toggle, the Postbox menu, a breadcrumb, two agent chips with status words, the conversation menu, Jump to, the needs-you button and the gear ([top-bar.png](../tests/uat/screenshots/top-bar.png)). Intent.md supports four agents per room. Each chip with its status word is about 170 px wide, so four of them, plus a long project and conversation name, exceed the width. The chips and breadcrumb don’t shrink.

**Why it matters.** The top bar is where you see who is working right now. If it wraps or clips, the status words disappear in exactly the case where several agents work at once.

**Recommendation.** From three agents up, show the chips as overlapping rings with a count (“4 agents”), and list them with status words in a popover. Let the breadcrumb truncate the conversation name first.

### 1.5 Wide content and the thread panel compete for one column

**Observed.** Apps and big blocks use the full transcript width, by design. When the topic-thread panel is open, it takes 440 px on the right, and the transcript recenters in what’s left ([topic-thread-panel.png](../tests/uat/screenshots/topic-thread-panel.png)). At 1280 px with the rail open, an app in the transcript gets about 590 px, close to the phone breakpoint its check tests at 375. The rail can now be hidden, but nothing suggests it when the panel opens.

**Why it matters.** Apps are the product’s distinctive output. An explorer squeezed to 590 px while you discuss it in a thread is the common case for “Reply in thread” under an app.

**Recommendation.** Hide the rail automatically when a thread panel opens below about 1440 px, and bring it back when the panel closes. Make the panel resizable.

### 1.6 Wait states compete for the same amber

**Observed.** Amber marks the needs-you ring, the needs-you pill, the active rail row, links, primary buttons, permission and wake cards, and the chosen option in a choice. In the overview, the four needs-you cards are amber-bordered, and so are their option chips ([overview.png](../tests/uat/screenshots/overview.png)).

**Why it matters.** Intent.md made amber the only interaction color on purpose. But needs-you is a state, not an interaction. When it uses the same color as every button, it stops standing out, and principle 3 says the eye should be drawn only when it matters.

**Recommendation.** Keep amber for interaction. Give needs-you its own token: the existing pulse, plus a distinct border weight or a tinted header band on the card, not the same amber outline buttons use.

**Done** (24 October 2026, #8). A card that needs you has a 3 px amber top edge and a head band in its own token, `--needs-band`; buttons keep the 1 px amber outline. intent.md records the rule.

## Part 2: the end-to-end experience

### 2.1 Agents change files, and Postbox never shows what changed

**Observed.** Claude Code agents edit files in the project folder. Postbox shows tool calls as activity lines (“Edited schema.md”), but nowhere shows the change itself, what changed across a turn, or how to undo it. Agents in a room share the project’s root folder ([`server/adapters/claude-code.mjs`](../server/adapters/claude-code.mjs), `folderFor`), so two agents can edit the same file in the same minute.

**Why it matters.** Every coding-agent manager reviewed isolates each task in a worktree or VM and ends it in a reviewable diff and a pull request [S1][S2][S4][S9]. The competitive analysis calls this Postbox’s largest gap. Without it, “done” has no concrete form, and the review block, Postbox’s strongest feedback tool, can’t be pointed at the agent’s actual changes.

**Recommendation.** At the end of each turn that changed files, show a changes card: files touched, a diff, Keep or Undo, and “Review these changes”, which opens the existing review block on the diff. Then offer a worktree per conversation as an option, so agents in a room can work without colliding.

### 2.2 Approvals have two answers, and real answers have more

**Observed.** The permission card offers Allow and Don’t allow ([permission-card.png](../tests/uat/screenshots/permission-card.png)). To allow a command with one flag changed, you deny it and explain in the composer, which costs a turn. Every allow is one-off, so the same safe command asks again next time.

**Why it matters.** “Yes, but change this” is the most common real answer to a proposed command. Agent Inbox offers accept, edit, respond or ignore [S46], LibreChat lets you edit arguments before approving [S39], and the OpenAI Agents SDK makes decisions sticky [S43]. Auto mode reduces how often you’re asked, but the questions that remain are exactly the hard ones.

**Recommendation.** Add Edit (change the command, then allow it, through the prompt tool’s `updatedInput`), Always allow this command in this conversation, and Don’t allow with a short reason that goes to the agent.

### 2.3 There’s no step to agree on the approach before the work

**Observed.** An agent starts acting on the first message. The parts for a plan step exist (the review block, choice and confirm), but nothing asks an agent to propose a plan first.

**Why it matters.** Devin returns an editable plan within seconds [S12], Jules has Interactive Plan and a planning critic [S13][S13a], and Copilot has Plan Mode [S8]. Fixing an approach is cheap, and fixing code is not. Postbox already has the best plan-review surface of the group: line comments on Markdown.

**Recommendation.** Add a per-persona “Plan first” option. The agent then opens each task with a plan as a review block, and works only after you approve it. The guide teaches the pattern, and the recipe documents it.

### 2.4 A first-time user can’t tell the mock from a real agent

**Observed.** The sample agents run on Claude Code when it’s installed, and on the mock otherwise or in `--demo`. The UI shows which only inside the persona editor’s “Runs on”. During this project, the user ran a `--demo` server for hours and concluded that “I seem to be looking at the fake version and not the version integrated with an agent.” Nothing on screen said so.

**Why it matters.** Trust in the product depends on knowing whether a reply came from a model. Scripted replies that look real are a liability outside the demo.

**Recommendation.** Mark mock agents everywhere they appear, with “mock” next to the name in chips, rows and speaker lines. Show a “Demo mode: scripted agents” banner when `--demo` is on. On a first run without Claude Code, say so on the overview, with how to install it.

### 2.5 You can’t see what agents cost

**Observed.** Each Claude Code turn ends with a `result` event that includes `total_cost_usd` and per-model use (`modelUsage`). Postbox reads the token counts for the context ring and discards the cost: nothing in `server/` reads either field.

**Why it matters.** One person directing several agents in parallel is spending money in parallel. The overview is the natural place to see it. A room where agents keep waking each other is exactly where cost runs away unnoticed; the wake limit caps the loop, not the spend.

**Recommendation.** Keep cost per turn and per session. Show it on session cards and in the conversation menu, with a per-day total on the overview, and an optional budget per persona that pauses the agent when it’s reached.

### 2.6 What a room knows ends with its sessions

**Observed.** A room’s memory is its sessions’ context. Compaction summarizes it, and the catch-up added for issue #1 shares it among the room’s agents. Nothing carries a room’s conventions (“we index the 1874 Middlemarch”) into a new session, and there’s no search across conversations ([intent.md](intent.md) lists it as missing).

**Why it matters.** Claude Tag keeps short notes per channel that anyone can ask about and correct, and its docs warn against turning memory into a log [S27]. Postbox calls its conversations a memory tool, so this is its own stated purpose: memory you can see and fix.

**Recommendation.** Add room notes: a short, editable list in the conversation menu, with an MCP tool for agents to propose additions. Include the notes in each new session’s brief. Search across conversations can follow.

### 2.7 Agent apps are islands in a standard world

**Observed.** `show_app` and the kit bridge are close in shape to MCP Apps: a sandboxed iframe with JSON-RPC over postMessage [S14]. But Postbox can’t show an MCP Apps server’s UI, and its agents’ apps can’t run in Claude or ChatGPT, which both render MCP Apps [S14].

**Why it matters.** The two-tier design matches where the industry settled. A2UI standardizes catalogs and MCP Apps standardizes sandboxed HTML [S22][S14]. Compatibility would bring in third-party tool UIs for free, and let the apps Postbox’s agents write travel with them.

**Recommendation.** Support MCP Apps’ `ui://` resources as a second app source. Map the kit bridge onto its JSON-RPC methods where they overlap.

### 2.8 Hidden tabs miss what needs you

**Observed.** Needs-you signals are an in-app toast, the tab title and the favicon. Intent.md rules out OS notifications by choice.

**Why it matters.** Dispatch mode means you’re doing something else while agents work. A permission card in auto mode is rare, which makes it easy to miss, and the agent stalls until you see it. Intent.md’s reason for no OS notifications was calm, but a blocked agent is the one case principle 3 says should draw the eye.

**Recommendation.** Add an opt-in, off by default: “Notify me when an agent is blocked”, for blocking events only (permission, failed, wake limit). Keep everything else in-app.

## Strengths to keep

The same evidence shows where Postbox is ahead, and changes shouldn’t erode these:
- **Forks you can bring back.** Topic threads fork the real session and bring back a reply or a summary [S11][S37][S45].
- **Agents that share a room** with tool permissions and capped wakes. No reviewed product has all of these [S1][S4][S26][S41].
- **Both tiers of agent UI**, with a check that runs before an app is shown [S14][S15][S22].
- **Review with line comments** on Markdown, code and apps.
- **Local and keyless**, with no network access for apps.

## Recommendations and issues

| # | Recommendation | Area | Priority | Issue |
|---|---|---|---|---|
| 2.1 | Show and review what agents changed on disk; worktree per conversation | Functional | High |[#9](https://github.com/HJeon139/postbox/issues/9) |
| 1.3 | Make persona tools real for real backends, or relabel them | Functional | High |[#5](https://github.com/HJeon139/postbox/issues/5) |
| 2.4 | Mark mock agents and demo mode everywhere | Functional | High |[#12](https://github.com/HJeon139/postbox/issues/12) |
| 2.2 | Edit, always-allow and reasons on permission cards | Functional | High |[#10](https://github.com/HJeon139/postbox/issues/10) |
| 1.1 | A denser overview that leads with what needs you | Layout | High |[#3](https://github.com/HJeon139/postbox/issues/3) |
| 2.3 | Plan-first option per persona | Functional | Medium |[#11](https://github.com/HJeon139/postbox/issues/11) |
| 2.5 | Cost per turn, session and day, with optional budgets | Functional | Medium |[#13](https://github.com/HJeon139/postbox/issues/13) |
| 1.2 | One word for conversations, another for threads | Layout | Medium |[#4](https://github.com/HJeon139/postbox/issues/4) |
| 1.5 | More room for apps when a thread panel opens | Layout | Medium |[#7](https://github.com/HJeon139/postbox/issues/7) |
| 2.6 | Room notes that carry into new sessions | Functional | Medium |[#14](https://github.com/HJeon139/postbox/issues/14) |
| 1.4 | Top bar chips that fit a full room | Layout | Low |[#6](https://github.com/HJeon139/postbox/issues/6) |
| 1.6 | A needs-you treatment distinct from interaction amber | Layout | Low |[#8](https://github.com/HJeon139/postbox/issues/8) |
| 2.8 | Opt-in OS notifications for blocking events | Functional | Low |[#16](https://github.com/HJeon139/postbox/issues/16) |
| 2.7 | MCP Apps compatibility | Functional | Low |[#15](https://github.com/HJeon139/postbox/issues/15) |
