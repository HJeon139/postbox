# Refusal card

![Refusal card](../../screenshots/refusal-card.png)

**Where:** In the conversation, when Claude Code refuses an agent’s or a subagent’s tool call without asking you.

## Why it exists

Auto mode’s safety check, a deny rule, or the permission mode can turn a call down without a permission card. Without this card the agent just stops, and fixing it means leaving Postbox for a terminal ([#65](https://github.com/HJeon139/postbox/issues/65)).

## Expected functionality

- Names who was refused (the agent, or its subagent by name), the exact command or input, and why.
- **Allow once and retry:** the next turn runs with that exact call allowed, and the agent is told to try again.
- **Always allow …:** adds the rule shown on the card to `.claude/settings.local.json` in the agent’s folder, which your terminal sessions read too, then the agent tries again.
- **Leave it:** keeps the refusal; the agent isn’t woken.
- The agent needs you until you answer; the overview card has the same buttons, so you can answer without opening the conversation.
- A call you declined on a permission card never gets a refusal card too.
- The refused step shows in the activity list as refused, pointing to the card.

## Steps to reproduce

1. Run the demo (`node tools/demo.mjs --port 4180`) and open <http://127.0.0.1:4180/> while it plays; keep the tab open.
2. Scene 10b (“Tidy the workspace”): the subagent’s `rm` is refused. Check the card and the overview card, then answer Allow once and retry.
3. Run Postbox with real agents (`node server/index.mjs --port 4181 --data /tmp/pb-uat-real --fresh`), with Claude Code installed and signed in, and open <http://127.0.0.1:4181/>. In the agent’s folder, add `"permissions": { "deny": ["Bash(rm:*)"] }` to `.claude/settings.local.json`. Ask the agent to delete a scratch file itself, then to have a subagent do it.
4. In step 3, answer Always allow on one card. Check `.claude/settings.local.json`, and run `/permissions` in a terminal in the same folder.

**Pass if:**
- Every refusal has a card naming the right agent or subagent.
- Allow once makes the agent retry and succeed once.
- Always allow writes the rule, and the CLI lists it.
- A deny rule still wins over it, and the card says so.

## Related

- [Permission card](permission-card.md)
- [Activity line](../transcript/activity-line.md)
- [Working row](../transcript/working-row.md)
