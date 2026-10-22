# User acceptance tests

One file per UI component, nested the way the interface is. Each says why the component exists, what it should do, and the steps to check it, with a screenshot of the component taken from the demo.


**These docs check each component with the demo’s mock agent. To test the product end to end, with real agents, real data and a tester model playing the person, use the [end-to-end UAT](e2e/README.md).** It’s the one that catches the defects people actually hit.
## How to run a UAT pass

1. Run the demo (`node tools/demo.mjs --port 4180`) and open <http://127.0.0.1:4180/> while it plays; keep the tab open.
2. For the real-agent steps: Run Postbox with real agents (`node server/index.mjs --port 4181 --data /tmp/pb-uat-real --fresh`, with Claude Code installed and signed in) and open <http://127.0.0.1:4181/>.
3. Work through the files below. For each, follow the steps, compare with the expected functionality, and mark it pass or fail.
4. File each failure as a GitHub issue with the bug template: impacted component, urgency, steps to reproduce, what was expected, what happened instead.

Screenshots are regenerated with `node tools/shoot-uat.mjs` (all) or `ONLY=rail,composer node tools/shoot-uat.mjs` (some). They’re taken at 1280 px in light mode, after the demo has played.

## Components

- **shell/**
  - **top-bar/**
    - [Top bar](shell/top-bar/top-bar.md)
    - [Postbox menu](shell/top-bar/postbox-menu.md)
    - [Conversation menu](shell/top-bar/conversation-menu.md)
  - [Permissions panel](shell/permissions-panel.md)
  - [Command palette](shell/command-palette.md)
  - [Toast](shell/toast.md)
  - **rail/**
    - [Rail (sidebar)](shell/rail/rail.md)
    - [Rail row](shell/rail/rail-row.md)
- **overview/**
  - [Overview](overview/overview.md)
  - [Session card](overview/session-card.md)
  - [Session menu](overview/session-menu.md)
  - [Archived sessions](overview/archived-sessions.md)
- **project/**
  - [Threads view](project/threads-view.md)
- **conversation/**
  - **transcript/**
    - [Empty conversation](conversation/transcript/empty-conversation.md)
    - [Your message](conversation/transcript/user-message.md)
    - [Agent reply](conversation/transcript/agent-reply.md)
    - [Activity line](conversation/transcript/activity-line.md)
    - [Working row](conversation/transcript/working-row.md)
    - [Citations and sources](conversation/transcript/citations.md)
    - [Glossary terms](conversation/transcript/glossary-terms.md)
    - [Mermaid diagram](conversation/transcript/mermaid-diagram.md)
    - [Math](conversation/transcript/math.md)
    - [System lines](conversation/transcript/system-lines.md)
    - [Failed and stopped replies](conversation/transcript/failed-and-stopped.md)
    - [Message actions](conversation/transcript/message-actions.md)
    - [Shared from a thread](conversation/transcript/shared-from-thread.md)
    - [Command item (!)](conversation/transcript/command-item.md)
  - **blocks/**
    - [Choice block](conversation/blocks/choice.md)
    - [Form block](conversation/blocks/form.md)
    - [Table block](conversation/blocks/table.md)
    - [Progress block](conversation/blocks/progress.md)
    - [Card block](conversation/blocks/card.md)
    - [Confirm block](conversation/blocks/confirm.md)
    - [Image block](conversation/blocks/image.md)
    - [Code block](conversation/blocks/code.md)
    - [Review block](conversation/blocks/review.md)
    - [Invalid block fallback](conversation/blocks/invalid-block.md)
  - **harness-cards/**
    - [Permission card](conversation/harness-cards/permission-card.md)
    - [Refusal card](conversation/harness-cards/refusal-card.md)
    - [App send card](conversation/harness-cards/app-send-card.md)
    - [Wake-limit confirm](conversation/harness-cards/hop-confirm.md)
    - [New teammate proposal](conversation/harness-cards/proposal-card.md)
  - **agent-apps/**
    - [Agent-written app](conversation/agent-apps/app-frame.md)
    - [Kit charts](conversation/agent-apps/charts.md)
    - [Narration player](conversation/agent-apps/narration-player.md)
    - [Diagram legibility lint](conversation/agent-apps/diagram-lint.md)
  - **composer/**
    - [Composer](conversation/composer/composer.md)
    - [Add menu (+)](conversation/composer/plus-menu.md)
    - [Mention menu](conversation/composer/mention-menu.md)
    - [Command menu (/)](conversation/composer/command-menu.md)
  - **panels/**
    - [Topic thread panel](conversation/panels/topic-thread-panel.md)
    - [Side thread panel](conversation/panels/side-thread-panel.md)
- **sheets/**
  - [New agent sheet](sheets/new-agent.md)
  - [New conversation and New room](sheets/new-conversation-and-room.md)
  - [Rename](sheets/rename.md)
  - [Delete conversation](sheets/delete-conversation.md)
  - [Delete session](sheets/delete-session.md)
  - [Attach a Claude Code session](sheets/attach-session.md)
  - [Project folder picker](sheets/folder-picker.md)
  - **settings/**
    - [Settings: Appearance](sheets/settings/appearance.md)
    - [Settings: Personas](sheets/settings/personas.md)
    - [Settings: Projects](sheets/settings/projects.md)
    - [Settings: Connect an agent](sheets/settings/connect-an-agent.md)

## Runs

### 21 October 2026

Two adversarial testers ran every doc here in headless Chrome: one against the shell, overview and sheets, and one against the transcript, blocks and agent apps, including a few turns with real Claude Code agents. They found 26 bugs, each reproduced at least twice from a fresh start, and filed as issues [#17](https://github.com/HJeon139/postbox/issues/17)–[#42](https://github.com/HJeon139/postbox/issues/42). The user also filed [#2](https://github.com/HJeon139/postbox/issues/2).

Fixed in the same change:
- **Critical:** #30 (agent HTML in a proposal card), #31 (one agent overwriting another conversation’s app).
- **High:** #17 (Rename), #18 (messages typed offline), #19 (editing a queued message), #32 (form errors).
- **Medium:** #2 (top bar ring), #20, #21 (composer only; block buttons stay live), #22, #23, #24, #25, #33, #34, #35.
- **Low:** #27, #39, #40, #42.

Still open: #26 (focus in sheets), #28, #29, #36, #37, #38, #41.

Docs that passed as written, for both testers: everything not named in an issue above. Not covered: Personas › Permissions and attach-session (they need Claude Code), and step 3 of the topic thread panel (it needs real agents).
