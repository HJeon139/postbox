# Sprint 3: retrospective and the kit for sprint 4 (3–6 November 2026)

A work-in-progress folder, not meant to merge, in the shape of `wip/sprint1-retro` and `wip/sprint2-retro`. It holds the room’s blind retrospective, the action items the person approved, and what sprint 4 starts from. Host names, accounts and local paths are left out.

The room: `scrum-master`, `critic` and `researcher` on the person’s computer, and five leads on one build host, each with subagents: `lead-host-install`, `lead-cards`, `lead-delivery`, `lead-transcript` and `lead-measure`. Two lanes ran: the hotfix lane, and #508’s close-out. The person was the only reviewer and merger.

## Start here

The retrospective as filed is #842. The rest of the records start here:

1. `state-at-close.md`: the open PRs, the work carried into sprint 4, and the decisions waiting on the person.
2. `action-items.md`: the actions approved for sprint 4, with owners, measures, and the issue drafts for the build items.
3. `continue-sprint4.md`: the prompt to paste as the first message of the sprint 4 room.
   `scrum-master-sprint4.md` is the context prompt for the sprint 4 scrum master.
4. `retro/aggregate.md`: what the team said, by theme, with who raised each and the evidence.

## The records

- `retro/PROMPT.md`: the six questions and the blind rules.
- `retro/<handle>.md`: the seven blind answers. Each was posted in the room as a sha256 before anyone read the others, and the files here are byte-identical: critic `be6eaec7`, researcher `91d81971`, lead-host-install `f4775286`, lead-cards `636b0816`, lead-delivery `1cc8f76c`, lead-transcript `c7c9c1ca`, lead-measure `f61393ee`. critic and lead-host-install replaced their first hashes (`305af357`, `cbf2a55d`) before the reveal, to correct one fact. Where an answer is wrong as written, the aggregate notes the correction.
- `retro/aggregate-revision-1.md` and `retro/aggregate.md`: revision 1, then revision 2 after 40 line comments from the seven agents. The person approved revision 2 on 6 November 2026.
- `estimates/`: each blind estimation round (`hashes-S3-<round>.txt`, with its reveal line) and the cards behind them (`cards/`, `cards-1c/`, and the leads’ first-round files).
- `apps/`: the sprint board and burndown (`board.html`), the closing demo (`demo.html`) and the retro explainer (`retro.html`), as they last stood, with their data inline. The demo’s UAT screenshots are left out, because they show local paths, so its image slots are empty here.

## What the room shipped

25 PRs merged, plus the integrator’s chores #756 and #801: #633, #701, #708, #735, #736, #740, #741, #742, #743, #755, #758, #760, #761, #762, #769, #770, #771, #772, #774, #775, #776, #777, #781, #802 and #826. Four PRs were open at the close (#773, #783, #808, #825), and #615 is parked.
