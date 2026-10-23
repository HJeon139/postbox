# Prompt: wave 4, supervision (#3, #101)

A wave 4 session, integrated by the reviewing session. Follow [README.md](README.md) for the rules every session shares: ports, file ownership, the scope rule, the gate and the hand-off. Your ports are 4600–4649 for servers and 9800–9849 for Chrome.

---

You’re making the overview the place to supervise several agents at a glance, on the branch `fix/w4-supervision`, in one pull request with one commit per issue.

## Why

intent.md’s dispatch mode: several agents work in the background, and the person checks progress and answers the one that’s blocked. The overview exists for that glance. Today it fails it two ways:
- **#3:** idle sessions are as tall as the ones that need you. With 12 sessions the overview is about 1,930 px tall, and about half of each idle card is sections that say “None” or repeat the header. The manual UAT of 23 October 2026 found one card writing “nothing here” three ways (“—”, “None yet”, “None”) and footers out of line across a row (#3’s last comment).
- **#101:** the overview fills with sessions over time, many of them the same persona. The person asked for closed conversations to archive their sessions, possibly after a time, and said session management belongs with the project or room, not one card per session (#3’s second comment).

Both were held until P0, the P1s and wave 3 merged, because they depended on which sessions exist (#121 and #110, merged in #171: one session per persona per conversation, with side-thread forks shown in their conversation) and where an agent’s controls live (#105, merged in #142: the sidebar’s Agents section). That’s now true.

## Start with a decision, not code

#101’s open questions are the person’s to decide. Before building, write a short proposal as a comment on #101, grounded in the current code, and get the person’s answer (ask them directly):
1. **What the overview lists.** One card per conversation with its agents inside, or per session? Forks from #171 are already nested under their persona in the sidebar.
2. **When a session leaves the overview.** When its conversation is archived or deleted; and whether idle sessions archive after a time (#101’s TTL), with what default and where it’s set.
3. **What “archived” keeps.** Archived sessions already have a page (`#/archived`). Say what restore does.

Measure before proposing: count the sessions the demo seed and a real data folder produce (`store.state.sessions`, by state and by conversation), so the proposal says how much each choice removes.

## The work, after the decision

- **#3, denser overview:**
  - Hide sections with nothing in them.
  - Fold the current step into the header when it only repeats the state.
  - Collapse idle sessions (or conversations) into one compact row each (ring, name, conversation, last message), below what needs you and what’s working.
  - Use one word for nothing, wherever a section still shows.
  - Cards in a grid row line up.
- **#101, sessions that leave:** what the person decided, through the runtime’s existing archive paths (`archived`, `#/archived`). Never delete a session’s transcript without the person’s action.

**Not in this session:** #8 (a needs-you color apart from interaction amber) moves to wave 5 with #181, since both decide what amber means. Keep needs-you as it is.

## Files

- **Yours:**
  - `app/js/shell.mjs`, the overview (`mountOverview` and its card code);
  - the runtime’s `liveSessions` / `needsYou` / archive paths, in `server/runtime.mjs`, only the functions named;
  - the overview’s CSS in `app/workbench.css`;
  - `tests/uat/overview/`.
- **Shared, so stay in your functions:**
  - **`server/runtime.mjs`:** the blocks session (#106) clears `needs` through existing paths but doesn’t change `needsYou`.
  - **`app/js/shell.mjs`:** wave 5’s visual consistency session comes after you.

## Done when

- #101’s decision is recorded on the issue, and the code follows it.
- With the demo seed, the overview fits what needs you and what’s working above the fold at 1280 × 900. Idle ones are compact rows. A headless check asserts both and runs clean with `--lag 300`.
- Archiving a conversation takes its sessions off the overview. They show under Archived, and restore brings them back.
- The UAT docs in `tests/uat/overview/` describe the new overview. Their text only; the reviewing session refreshes the screenshots.
