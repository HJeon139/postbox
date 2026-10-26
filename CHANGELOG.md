# Changelog

Every release of Postbox, newest first. Written by `npm run release` from the commits since the last one.

## 0.37.0 (2026-10-26)

### Features

- **remote:** give each host turn's shims a token of their own
- **remote:** carry a message's attachments in start, onto the host's turn folder
- **uat:** run agents on other machines over ssh, with the remotehosts scenario
- **uat:** drive the Hosts tab and Runs on as a person sets a host up
- **uat:** remote-aware checks and host-mode triggers
- **remote:** show hosts, where agents run and their remote turns' states; keep host files local
- **remote:** run a persona's turns on a host from the runtime, with states, resume and restart
- **remote:** serve Postbox's tools on a host, install its daemon, and run the harnesses there
- **remote:** run turns on a host through a daemon, a runner and a shim
- **remote:** lay the foundations for agents on remote hosts

### Fixes

- **agents:** say when /mode changed a running turn at once
- **remote:** admit a host turn's queued calls one at a time, so its shims can't pass the cap
- **remote:** drop the POSTBOX_REMOTE_HOME test hook from the host's code
- **remote:** a host card answered Allow just as the host gave up says it expired, not Allowed
- **remote:** put an urgent note first in a host call's answer, as on this computer
- **hosts:** refuse a host destination with spaces around it, rather than trim it
- **personas:** tie Runs on's errors to its select
- **hosts:** Remove's confirm says what stays, focuses Cancel first, and hands focus on after
- **permissions:** say in the panel that an agent on a host reads the host's settings files
- **remote:** cap a host turn's calls waiting for Postbox, and its record of them
- **remote:** hear a turn's messages only from the host it runs on
- **mcp:** export TOOL_DEFS from server/mcp.mjs again
- **remote:** keep ~/.ssh/config's forwards, X11, LocalCommand and host-key policy off Postbox's ssh
- **remote:** offer no Always allow on a host turn
- **uat:** refuse a host where Postbox is installed, unless --replace-host-install
- **remote:** give a host prompt's stored answer back only to the request it answered
- **uat:** a run's stop waits until its Chrome and Postbox have exited
- **checks:** splice values into the host checks' page code through js()
- **remote:** compare a host's token in constant time, and say why ssh's failure pattern is safe
- **uat:** click a host field again until it has focus
- **checks:** drop the test Chrome's background flags now that main emulates focus
- **remote:** continue a turn on its host as the turn it was, through restarts and Retry
- **remote:** keep thread.mjs under main's ceiling, and count a host's edits in Work's check
- **remote:** let a host take its own Postbox back after a dropped ssh
- **uat:** after Stop on a host, count what's left running in the run's folder
- **remote:** end a host's connection when ssh exits, and stop what it started
- **uat:** count a fault only when the host was seen cut off
- **uat:** give a scenario's permission mode to agents on Claude Code too
- **uat:** clean hosts up only by confirmed outcomes, on Ctrl-C too
- **remote:** give a host just added its status, so its card offers Install…
- **remote:** connect a host when the person installs, retries or reconnects
- **remote:** keep an answer given as Postbox shuts down, rather than crash
- **remote:** point an agent on a host at its copy of each attachment

## 0.36.4 (2026-10-26)

### Fixes

- **security:** run the scan's judge through a symlink, and choose it by what it does
- **check:** repeat a spec a retarget or merge brings in, and trust only Actions' own pass

## 0.36.3 (2026-10-26)

### Fixes

- **queue:** deliver refreshed context instead of dropping waiting handoffs
- **queue:** recheck pending batches before starting their turn
- **queue:** deliver queued wakes together and discard superseded requests

## 0.36.2 (2026-10-26)

### Fixes

- **adapters:** render context unknown on quick panel and initialize sessions at null ctx (#392)
- **adapters:** clear unknown context and cite Gemini 4 Argon window (#392)
- **adapters:** align Codex token usage shape and cite model context windows (#392)
- **adapters:** report active context usage for Antigravity and Codex (#392)

## 0.36.1 (2026-10-25)

### Fixes

- **agents:** match a running turn to its own conversation in the mode note
- **agents:** say when a running turn keeps its old permission mode
- **permissions:** let run everything answer only codex's own sandbox asks
- **permissions:** honor run everything in a turn that's already running

## 0.36.0 (2026-10-25)

### Features

- **adapters:** ask with a permission card via PreToolUse hook on Antigravity CLI (#370)

### Fixes

- **mcp:** match disconnected permission_prompt card by tool_use_id (#370)
- **adapters:** expire open permission card on disconnect and set agy hook floor to 1.4.7 (#370)
- **adapters:** use node:http without a 300s headers timeout in agy-hook (#370)

## 0.35.1 (2026-10-25)

### Fixes

- **ci:** call cancelled() only in an if, so the prompt gate runs again

## 0.35.0 (2026-10-25)

### Features

- **personas:** add the Gemini persona boilerplate

### Fixes

- **personas:** prefer b.model, disable unavailable boilerplates and keep seed order

## 0.34.0 (2026-10-25)

### Features

- **threads:** agents talk in the conversation; side threads are read-only

### Fixes

- **threads:** count each pair's wakes, and every wake a message makes
- **demo:** play the wake scene in the conversation

## 0.33.6 (2026-10-25)

### Fixes

- **settings:** its tabs wrap on a phone, so the dialog no longer scrolls sideways

## 0.33.5 (2026-10-25)

### Fixes

- **state:** the second id in a route is checked too, and the test reaches every route
- **state:** an id is a record the state has or nothing, never Object's prototype

## 0.33.4 (2026-10-25)

### Fixes

- **runtime:** an app's waiting card keeps its agent needing you through its turns

## 0.33.3 (2026-10-25)

### Fixes

- **server:** missing or bare static folders answer 404, and page files go through servedFile
- **ledger:** record a SHA-256 repository’s commits, whose shas are 64 hex
- **ledger:** git reads ignore commands a repository’s config names
- **server:** serve static files only from inside their folders, through links too
- **side-threads:** refuse a wake_agent message or post past 50,000 characters
- **datasets:** refuse a datasets folder that links out of the project
- **corpus:** hold corpus_search to 1–50 results and its first 50 book ids
- **mcp:** compare a tool call’s turn token in constant time
- **ledger:** refuse a commit sha that isn’t hex before it becomes git’s argument

## 0.33.2 (2026-10-25)

### Fixes

- **thread:** note a clamp only when it left the view at the page's end
- **thread:** keep the view on what you read when the page changes under it

## 0.33.1 (2026-10-25)

### Fixes

- **deps:** move sharp to 0.35.5 and body-parser to 2.4.0
- **uat:** pick canary words with randomInt, not a byte modulo the list
- **uat:** escape backslashes in report table cells
- **markdown:** strip tags in one place, until none is left
- **markdown:** close a fence by comparing its run, not a regular expression built from text

## 0.33.0 (2026-10-25)

### Features

- **archive:** sessions are archived and deleted with their conversation; nothing archives itself
- **wakes:** raise the wake limit from 3 to 10
- **shell:** ring-only to the ask, and no overview, Archived page or top-bar rings
- **reactions:** all five inline beside Reply in thread, with who reacted

### Fixes

- **shell:** deleting a conversation's only agent leaves it, not back into it
- **css:** the live regions don't make the page taller than the app

## 0.32.4 (2026-10-25)

### Fixes

- **uat:** keep the checkout's AGENTS.md from the tester and verifier too
- **uat:** keep the checkout's AGENTS.md out of a run's Claude Code agents

## 0.32.3 (2026-10-25)

### Fixes

- **permissions:** bound the command scan's work, and read a backslash-newline out of each part
- **uat:** the allow-once triggers import the scanner from shared/
- **permissions:** read a command's parts as the shell does for the write guard

## 0.32.2 (2026-10-25)

### Fixes

- **shell:** a waiting agent's ring and row don't say they open a dialog, or whether one is open
- **shell:** a menu closed before it listened no longer closes every later menu

## 0.32.1 (2026-10-25)

### Fixes

- **permissions:** read a backslash-newline and escaped quotes around a heredoc as the shell does
- **permissions:** read a heredoc's word as the shell does, so a quoted or dashed one isn't chained
- **permissions:** no Allow once or Always allow for a chained command, which no rule can match

## 0.32.0 (2026-10-25)

### Features

- **shell:** a needs-you ring or row goes to that agent's ask, and ⌃J lands reliably

### Fixes

- **shell:** leave modifier clicks and the top bar's ring stack to their own behavior
- **checks:** a headless check that recorded no case fails
- **checks:** keep headless Chrome's page focused, so an Escape doesn't freeze it

## 0.31.0 (2026-10-25)

### Features

- **uat:** cap a whole run's cost with --max-cost, and stop it with its report

### Fixes

- **uat:** count each resumed session's cost once

## 0.30.2 (2026-10-25)

### Fixes

- **uat:** honor send_then_stop's delay and hand the job question to the tester
- **stop:** settle a stopped turn's running steps, and its reply's header

## 0.30.1 (2026-10-24)

### Fixes

- **agents:** shorter setup guidance, safe in bypass mode, and none in agy's full rules file
- **agents:** ground setup diagnosis in evidence
- **uat:** count filed findings in recurrence

## 0.30.0 (2026-10-24)

### Features

- **reactions:** switch to the person's final icon set

## 0.29.0 (2026-10-24)

### Features

- **threads:** Summarize back from a side thread, as from a topic thread
- **composer:** ask “Did you mean @critic?” when a draft names an agent without its @

### Fixes

- **composer:** shorter thread hints, so a thread's composer sits as high as the conversation's
- **threads:** a summary's review_block wakes no one either
- **threads:** keep a queued summary pending while its turn starts
- **threads:** say on the sender line when a scheduled wake started the turn
- **threads:** give each wake an agent sends from another turn its own sender line
- **telemetry:** count agents' wake chains from each wake's message, now that wakes have no line
- **threads:** one line per side thread in the conversation, not one per wake
- **composer:** say whom a message that mentions an agent wakes, not who it replies to
- **thread:** give a later turn of the same agent its own sender line, with what woke it

## 0.28.1 (2026-10-24)

### Fixes

- **permissions:** expire a permission card a minute before Claude Code gives up on the call
- **permissions:** offer permission_prompt only to the CLI, and expire a card at 25 hours
- **permissions:** a tool card answers itself when the tool is turned on elsewhere

## 0.28.0 (2026-10-24)

### Features

- **overview:** give a card that needs you a look of its own

### Fixes

- **look:** light mode keeps its fills, and focus-clear places its message under the composer
- **contrast:** check the app's stylesheet when none is named
- **a11y:** keep what has focus clear of the sticky composer
- **ui:** mark every text button as a control, with a border or an underline
- **composer:** line up the thread panel's composer with the conversation's
- **ui:** give boxes that wrap a card's corners, not pill ends
- **ui:** show selected segments, chosen chips and on toggles as amber outlines

## 0.27.1 (2026-10-24)

### Fixes

- **threads:** space a shared reply's question as a message is
- **threads:** draw a shared reply's question apart from its answer
- **threads:** keep the question with shared replies

## 0.27.0 (2026-10-24)

### Features

- **reactions:** let agents react to any message, their own included

### Fixes

- **reactions:** flag-misplaced counts only the runner's own 🚩, and two window comments
- **reactions:** say "you" in words on a shared chip, and the review's telemetry and UAT fixes

## 0.26.0 (2026-10-24)

### Features

- **reactions:** draw each reaction with its icon

### Fixes

- **reactions:** the UAT's telemetry driver finds a reaction by its icon, and every icon is checked

## 0.25.1 (2026-10-24)

### Fixes

- **stop:** four review fixes: a stopped kept job, Send now's sender, shared groups, a stray kill
- **stop:** a stopped reply's tag grows to two lines where its words wrap, not out of its pill
- **stop:** stopping one of two kept jobs that share processes ends the other as stopped
- **stop:** say why a reply stopped, and tell the agent its kept jobs weren't stopped

## 0.25.0 (2026-10-24)

### Features

- **telemetry:** record every UAT run, and put Telemetry in Work's place
- **telemetry:** keep recordings per conversation, bound the classifier, and prove the gate
- **telemetry:** open the report in a Telemetry view beside the room
- **telemetry:** record a room, and gate its report, unlisted

### Fixes

- **telemetry:** a clone on its own data/ can't record, per the person's ruling on #239
- **telemetry:** the fourth review's findings on #239
- **telemetry:** the third review's findings on #239
- **telemetry:** the second review's findings on #239
- **telemetry:** the review's page findings on #239, and a browser check
- **telemetry:** the review's server findings on #239
- **telemetry:** react 🚩 once per item at the end of a UAT run
- **telemetry:** fixes from the first UAT runs
- **telemetry:** read only Postbox's own tool results in recording-visible

## 0.24.0 (2026-10-24)

### Features

- **review:** let an agent comment on another agent's review block
- **review:** preview a draft whole, comment on a selection, and go wide or full screen

### Fixes

- **review:** the block's agent can't rewrite or drop a reviewer's comments in a thread it sends back
- **review:** a click on an image that failed to load opens Lines at its line
- **review:** refuse a revision that would push a reviewer's kept thread past 200
- **review:** keep focus on the Comment button when the selection is heard again
- **review:** draw a review's Markdown images

## 0.23.0 (2026-10-24)

### Features

- **glossary:** link terms inside a definition, and stack their hover cards

### Fixes

- **blocks:** an escape before a carriage return no longer makes the highlighter backtrack
- **thread:** draw math, diagrams and glossary terms in a reply shared back from a thread
- **blocks:** show the code block's filename in its header, and highlight its code

## 0.22.0 (2026-10-24)

### Features

- **threads:** react to a message with an emoji, and the agent hears it as feedback

### Fixes

- **threads:** tell a thread's reactions to its own agents, and keep the review's fixes

## 0.21.0 (2026-10-24)

### Features

- **uat:** --force-agent-model runs a models: persona scenario on the run's model

## 0.20.0 (2026-10-24)

### Features

- **pane:** reopen a thread left open when you come back to its conversation
- **pane:** resize the right pane from a handle on its left edge
- **pane:** hide the sidebar while the right pane needs its room

### Fixes

- **pane:** an honest sidebar button beside the pane, and widths without the scroll bar
- **pane:** keep the sidebar button true, and the sidebar out of the pane's way
- **pane:** keep the conversation column usable beside the right pane

## 0.19.0 (2026-10-24)

### Features

- **agents:** End on a subagent's row tells its agent to stop it

### Fixes

- **side-threads:** one session per agent per conversation, and no forks

## 0.18.0 (2026-10-24)

### Features

- **work:** list what each turn did under its last reply, each row opening Work at it

### Fixes

- **work:** say which time the reply's activity line and the turn's list show
- **ledger:** record commits and branches a command makes, from git before and after it

## 0.17.0 (2026-10-24)

### Features

- **apps:** agents retire an app they no longer need with retire_app

### Fixes

- **apps:** the integrator's review fixes for retiring apps and the app check
- **kit:** review fixes for the text and control checks
- **apps:** review fixes for retiring an app
- **kit:** the app check finds controls you can't see or click
- **kit:** the app check finds text that spills out of its box or over other text

## 0.16.0 (2026-10-23)

### Features

- **blocks:** agents withdraw a block that asks, and the person can dismiss one

### Fixes

- **a11y:** screen readers hear replies as plain text, with dots in words kept
- **markdown:** \(…\) and \[…\] are math, not escaped brackets
- **markdown:** $$…$$ on one line is display math
- **blocks:** Postbox's own images load at localhost, and a failed image says so
- **blocks:** tell a topic thread's agent that its conversation's block is there

## 0.15.0 (2026-10-23)

### Features

- **side-threads:** send a side-thread message to the conversation, yourself or by an agent
- **threads:** the Threads page lists side threads beside topic threads

### Fixes

- **side-threads:** a failed side-thread turn shows on its line, with Retry, and opens at its card
- **side-threads:** the side-thread line counts every message there

## 0.14.0 (2026-10-23)

### Features

- **uat:** print recurrence by issue in uat-stats

### Fixes

- **uat:** count a closed issue's recurrence only after it closed
- **uat:** count only a closed issue's regressions as its recurrence
- **uat:** read a draft that asks to go out, and a list put to the person
- **uat:** catch an updated app its last version didn't move
- **uat:** one regression comment per issue per run, only while it stands
- **uat:** comment a regression a later filing pass finds, and never preset when gh fails
- **uat:** verify a closed issue caught again against its fix
- **uat:** stop #63's check flagging reports and exercise answers
- **uat:** read moved blocks and apps in #123's and #49's checks

## 0.13.2 (2026-10-23)

### Fixes

- **adapters:** let a permission card wait a day on the Claude Code CLI

## 0.13.1 (2026-10-23)

### Fixes

- **adapters:** a failed Codex turn says why, from the error Codex reported
- **adapters:** a folder an agent can't work in says so, not that the CLI is missing
- **store:** a reconnecting browser no longer doubles a reply that was streaming

## 0.13.0 (2026-10-23)

### Features

- **agents:** show subagents' narration, thinking and hierarchy in the agent tree

### Fixes

- **agents:** Monitor and other background tools are jobs, and a step after a kept job runs on

## 0.12.0 (2026-10-23)

### Features

- **overview:** archive a whole conversation, and idle ones after 7 days
- **overview:** lead with what needs you, and list idle conversations as rows

## 0.11.0 (2026-10-23)

### Features

- **package:** install and run Postbox as an npm package
- **server:** keep the person's data and media in ~/.postbox

## 0.10.2 (2026-10-23)

### Fixes

- **shell:** clip the version menu's second line with an ellipsis too
- **shell:** label Work, fit long menus, and keep the folder picker usable around links

## 0.10.1 (2026-10-23)

### Fixes

- **shell:** the top bar keeps focus on its control when it repaints

## 0.10.0 (2026-10-23)

### Features

- **agents:** the room tells each agent who else is here, what each does, and how to share the work

### Fixes

- **personas:** shorter seeded prompts that say what to do and why; the researcher fits code work

## 0.9.0 (2026-10-23)

### Features

- **personas:** the researcher's prompt lives in server/personas, shared with its boilerplate
- **personas:** a fresh install seeds researcher, developer and critic

### Fixes

- **threads:** the agent tree's entries wrap instead of cutting off who they're with

## 0.8.0 (2026-10-23)

### Features

- **corpus:** agents load datasets into the corpus with add_dataset, with no restart
- **apps:** send a large app and its data as files, and require the turn's token on /mcp
- **apps:** an updated app moves to the newest point in the conversation

### Fixes

- **apps:** Postbox writes an app's "Sent from" line from what it sent, with the app's summary apart
- **blocks:** a block that asks again moves to the newest point in the conversation

## 0.7.0 (2026-10-23)

### Features

- **checks:** a reply that should have been a block comes back as a lint turn; a table rule
- **permissions:** writes outside Postbox wait on a card that shows the draft before anything exists

### Fixes

- **agents:** agents learn which tools are off and can ask for one on a card; ! in a thread says so
- **codex:** approval cards for MCP tool calls name the tool, in its own case, with its arguments

## 0.6.5 (2026-10-23)

### Fixes

- **threads:** side-thread sessions show in their conversation, stop with it, and can be linked
- **threads:** one session per persona per conversation; a side-thread wake forks only a busy session

## 0.6.4 (2026-10-23)

### Fixes

- **work:** a background command says it was stopped or kept, from the job's own events

## 0.6.3 (2026-10-23)

### Fixes

- **agents:** a block's answer says the person gave it, and read_message says where an item ends
- **agents:** history and read_conversation give a block's content and answer
- **agents:** history says where it cut an item, and read_message reads it in full

## 0.6.2 (2026-10-23)

### Fixes

- **stop:** never kill a background job you chose to keep running

## 0.6.1 (2026-10-23)

### Fixes

- **uat:** run.json records the effort agents ran at, and reports' Agents line is read back

## 0.6.0 (2026-10-23)

### Features

- **work:** agents in the sidebar, a Work ledger, and Work in a right pane with full screen
- **uat:** agents run on Haiku at low effort, and measurement scenarios keep the personas' models
- **uat:** test the Agents section, the Work ledger and the right pane

### Fixes

- **uat:** a stopped run stops its Postbox, and workspaces are their own git repos
- **agents:** word the quick panel's mode help with modeHelp, which replaced KIRO_PERMISSIONS

## 0.5.0 (2026-10-23)

### Features

- **checks:** run every headless check in parallel with npm run check:browser, in CI too

### Fixes

- **checks:** check-permissions waits on a time budget, and check-all says how it picks ports
- **transcript:** scrolled up, hold still the message across the middle of the view

## 0.4.0 (2026-10-23)

### Features

- **uat:** size runs by evidence, end phases on triggers, keep runs with verdicts, refit with stats

## 0.3.0 (2026-10-23)

### Features

- **rail:** show the build's version and commit under Personas
