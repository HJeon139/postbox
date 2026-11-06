# Sprint 3 retrospective: researcher

## 1. Setup

- **Running on the Mac helped my part most.** It let me reproduce the macOS-only findings before each fix and verify after:
  - #775: 6 of 70 failed on `048e3353`, and the fix `5e87c458` passed 140 of 140, plain and lagged;
  - #802: the remote tests passed 518 of 519, with the macOS `TMPDIR`, on `e7efb7f7`;
  - #806: the mods bypass, in a full Postbox turn (#806’s evidence comment).
- **Subagents kept broad reads out of my context:** the mods docs (`s3-reviews/mods-caps.md`, `mods-sec.md`), the source of 8 mods (`mods-src-notes-{a,b,c}.md`) and #780’s code map. I reran each one’s key claim myself, such as `holds-over.ts:22–39` and `agent-files.mjs:30–48`.
- **Load on the Mac got in the way.** It ran at a load average of 23 to 50 all afternoon. So #777’s under-one-frame rule never ran live, and that became #818. #802’s one full-gate failure, `browser-kill`, came at a load of 42–50 and passed 3 of 3 at the gate’s depth.
- **Messages held behind another agent’s wake got in the way.** My #777 and #775 results waited until the person allowed lead-measure’s wake. Twice, a lead was stopped before my results reached it, so I sent them again.
- **My own framing got in the way.** My first mods report was framed around permission cards. The person corrected me (“too much bias … read intent.md”), and r2 (`reports/mods-vs-postbox-r2.md`) maps mods against intent.md instead.

## 2. Planning

- **Blind poker worked:** hashes, then a reveal, with drivers that hint at no number. Rounds S3-2c, S3-2d, S3-3 and S3-4 all settled without a re-vote.
- **Measuring before estimating would have saved a round.** I carded #564-b1 at 8 on the batching scope. lead-transcript’s measurement then changed the scope to scoped queries, and it was re-carded at 5 in S3-2d. A small measurement before the first card would have saved that round.
- **The endgame table and the freeze helped.** I knew my items were all sprint 4, and wrote `notes/researcher-sprint4-handoff.md` early.
- **Times without a zone misled a decision.** Times given as “PDT” after daylight time ended moved the person’s choice on #826 (`s3-826-after-freeze`). The fix was simple: UTC on every time, which I check now.
- **What I’d change:** give every issue draft a priority question with no default. In the lag issue, the approval came with no priority (`s3-lag-priority`), and the person answered “P0” in a thread.

## 3. Execution

- **Where it flowed:** issue drafts, through critic and then the person, filed with an `@` scan and an exit code each time:
  - #797, #803 and #804;
  - #806, with its evidence and the P1 change;
  - #807, #817 and #821.
- **My worst wait:** the generic allow-list draft (`as_Rfa1dRT` v2). It waited from the first afternoon to the close on lead-host-install’s four host-turn questions, which were never answered. It went to sprint 4 without a critic read.
- **The second wait:** #671-b’s grooming questions to lead-delivery, which were never answered. Also sprint 4.
- **Two slips of mine on S3 rule 1:** the overlap map early in the sprint, and the #806 revision with the full-Postbox-turn result, shown to the person before critic read the new section. critic accepted the late read, with “next time, bring it to me first”.
- **A review that crossed a draft:** on the lag issue, critic’s read of r2 crossed r3. That cost a revision (r4 and r5). Sending critic the asset’s version number with each request would have prevented it.

## 4. Quality

I touched no PR’s code. These are the misses in work I wrote or verified.

- **My #780 security note was wrong about the Lines view.** It said Lines would show an image line’s Markdown, and it doesn’t. lead-cards found that on the branch (`s3-780-lines`).
  - **A second gap:** the note didn’t look at host tool routes. The live UAT (`2026-11-05T21-52-48-reviewfigures`) found that a host refusal of a queued `show_block` never reached the agent, which became #827.
  - **The check that would have caught both:** reading `review.mjs`’s Lines path and `remote/host/broker-tools.mjs`’s `prepare` while writing the note.
- **The mods report r1 quoted a line AGENTS.md doesn’t have.** critic caught it with `grep`. The check that would have caught it: grep every quoted line before sending.
- **#777: the integrator found PF-1 passing with Event Timing recording nothing.** My Mac run only reported “Every key had an Event Timing entry”. It never ran with an observer that saw nothing, so it couldn’t have shown the gap. lead-measure’s calibration key (round 3) is that check.
- **#802: I read its `browser-kill` failure as load, from 3 of 3 passes at the gate’s depth.** That holds, but I didn’t run `main` at the same load to compare, and said so.

## 5. Postbox and the hosts

- **Permission cards:** 48 cards in one evening, 44 of them git or gh, and 39 of those from host turns. The count is in the allow-list draft, `as_Rfa1dRT`.
- **A mod can approve past the card (#806, #817):** confirmed in a full Postbox turn. Nothing is exposed today, but it’s P1 for sprint 4.
- **A message to a busy agent in a thread doesn’t show until delivery (#803):** the person hit this one themselves.
- **`/tmp` inodes on the build host:** after #797 was filed, it climbed to 76% again before #802 merged (`s3-buildhost-tmp-clean-2`).
- **Lag spikes when switching projects:** filed as #821 (P0), because nothing in the runtime records them.
- **Turns stopped after 15 minutes of silence:** that happened to several leads. Wait-loops that print every few minutes fix it.

## 6. For sprint 4, in order

1. **#817 first.** Then the allow list, rebuilt on top of it, because a mod can settle a call before Postbox’s list ever sees it. The draft needs a re-read against #806.
2. **#821a early,** so the rest of #508’s work is measured in real use, and project-switch spans show where the person’s lag goes.
3. **A question waiting on another agent gets an owner and a deadline on the board,** like a PR does. The allow-list draft and #671-b waited all sprint for answers nobody tracked.
