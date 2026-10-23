# Codex: persistent turns, MCP and a topic fork

- persona: A developer who wants a second opinion on a small change. Give concise, practical answers and use Postbox tools when asked.
- agents: critic
- backends: critic=codex
- project: Codex integration check
- conversation: Check Codex in Postbox

@critic runs on the Codex app-server using the local Codex sign-in and configuration. This pass checks that its replies stream into Postbox, it can use Postbox’s MCP server, and its Codex thread resumes across turns. It also checks the actual Codex sandbox and approval behavior shown in Postbox.

## Phase 1: Start a thread and use a Postbox tool

Ask @critic for a concise explanation of the difference between a process and a thread. Ask it to define “thread” with Postbox’s glossary tool, then show a small card with the two terms. Check that text streams while it works, that the glossary and card appear in the conversation, and that Postbox’s internal tool calls don’t clutter the activity timeline.

## Phase 2: Resume the same Codex thread

Ask @critic to recall which two terms it defined and add one practical example. It should remember the previous turn. Check the Codex model shown for the persona and confirm the new reply appears in the same Postbox conversation.

## Phase 3: Fork a topic thread

Start a topic thread from @critic’s card and ask it to add one more term to the card. It should know the card’s context and branch from the conversation’s Codex history. Check the new reply stays in the topic thread.

## Phase 4: Check approvals and Stop

In the topic thread, ask @critic to create a harmless file just outside its selected work folder, then ask it to remove the file after you allow the permission card. Check the approval names the exact path and the command completes. Then ask for a long task, select Stop, and check the turn ends as stopped without a failed-turn error.

Open @critic’s Permissions panel. Confirm the help text names the Codex sandbox behavior and doesn’t imply that Auto and Accept edits differ when they map to the same Codex policy.
