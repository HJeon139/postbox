# Researcher’s blind retrospective, sprint 2

## 1. Room setup

- **Helped:** each agent running the gate in its own worktree at `origin/main`. My first gate in the shared checkout failed on another agent’s nested worktree (`tester-522/biome.json`), and my second, with `node_modules` linked from that checkout, failed on a missing `@playwright/test`; a fresh worktree with `npm ci` passed (my rule 11 reports; a temporary log, exit 0 at `46116a91`).
- **Got in the way:** the shared checkout sat on v1.0.0, 451 commits behind `main`, so every first gate in the room measured the wrong code (developer’s and critic’s rule 11 reports, and mine).
- **Got in the way:** the first message of the room, with the sprint prompt as an attachment, reached me with its path and no one else; scrum-master couldn’t open it and had to ask for it in a form. That is #671, which this room then fixed for local agents (#682).
- **Helped:** a role check from the session record (rule 11) and a fresh session for scrum-master rather than switching mine (`sprint2-researcher-next`, the proposed `scrum-master` teammate).
- **Got in the way:** a stuck “add tester” card held @-mentions for hours after the person declined it twice (scrum-master’s and critic’s messages; `Do you see an open card asking to add tester?`).

## 2. Grooming, estimation and planning

- **Worked:** grooming against the code before estimating found two P0s already fixed or mostly fixed (#427 by #597, #296 by #557 and #562), which closed with no code (`researcher-p0-groom-table`).
- **Worked:** parallel subagents for the 33-issue P1 queue, with one fixed report format and my own spot checks of their citations (`p1-groom-table`); it took minutes, not an afternoon.
- **My mistake:** I posted a card’s value (“my card (5) still holds”) after a scope change, which anchored round 5; scrum-master voided it (rule 13). I now post only the hash.
- **Change:** grooming should check the PRs that *mention* an issue, not only its own text: #427, #296 and #564 were each left open by a merged PR that linked no issue (`closingIssuesReferences` empty on #597, #557, #565).
- **Change:** the plan named #417’s file half (AP-1 and RF-2) as #516’s first slice before anyone had read what RF-2 depends on; the design found it needs the store and the folder first, and the plan changed (`design-516-r1`, plan change 1).

## 3. Execution

- **Flowed:** design, critic review, revision, person’s approval, then blind cards, all in the room: #516 went from requirements to a merged S1 (#679) the same day.
- **Waited:** my designs needed four revisions of S3 after approval. Critic found the orphan pass deleting by absence (P1, `critic-1`); claude-ssh found the host’s `TOOL_ROUTES` list I’d marked as “only if” (`design-516-s3-r3`); critic found F11 didn’t match the code’s erase order (`design-516-s3-r4`). Each was a claim I hadn’t read the code for.
- **Waited:** the person approved two of my designs before critic’s review (`design-516-r1` revision 1), so critic’s P1s came after approval and needed a second revision.
- **My mistake:** my grooming said #683’s cause was lost state keys; a subagent’s reading of `store-recover.mjs:62` showed snapshots keep unknown keys and the loss is unknown event types (`shared/state.mjs:158`). The issue text was filed from my earlier claim.
- **Flowed:** a deterministic browser probe settled the Mermaid report in one run (`with-lock.sh browser`, exit 0: the numbered labels showed “Unsupported markdown: list”).

## 4. Postbox itself

- An attachment on a message to one agent can’t be read by the others (#671); remote agents still can’t (#671-b, waiting on #516 S3).
- A review block’s `previous` needs the whole old text, so a revision of a long design meant pasting it twice; once I gave a summary instead and the diff became misleading (`design-516-s3-r1`, revision 2).
- I sent malformed form blocks twice (select options need `id`, not `value`); the person saw a plain-text fallback first (`d516-s3-decisions`, then `-2`).
- A declined add-agent card kept holding @-mentions (see 1).
- An agent reading a design on a host can’t see `.scratch/` on the laptop (claude-ssh, #417), so designs live only in the room’s blocks.

## 5. First three changes for sprint 3

1. Every design claim about a file, a list or an order cites the line it read, before critic sees it; a row with no citation is marked as an inference. (S3’s three post-approval fixes were each an unread claim.)
2. Critic reviews a design before the person is asked to approve it, or the approval block says it’s pre-review.
3. Grooming lists every merged PR that names the issue, with its “Not done”, so issues left open by unlinked PRs are proposed for closing at once.
