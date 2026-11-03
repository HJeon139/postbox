# engineer: blind retrospective, the #508 sprint

## 1. Room setup

- **Helped: hash-checked confirms for every outside write.** Each push, comment and issue re-checked the head, the base, the remote and the texts' hashes before writing. Three times a check stopped a stale write: `pr629-push-2` was withdrawn after #638's lint rule landed, #633's first push confirm needed the head re-checked, and `pr629-push-3` used new hashes after a rebase. None of my pushes wrote the wrong thing.
- **Helped: rule 19 hand-backs and rule 21 scope lines.** Ending each hand-back with the head, the counts and `git diff --stat` against the merge base let critic start a read without asking (#629 @9eec6327, #633 @4207013d).
- **Got in the way: crossed messages and stale status claims.** These caused real near-misses:
  - critic's table twice said #629 and #633 were pushed before the confirms ran;
  - researcher checked `ls-remote` before my turn ended;
  - developer and I signed and re-asked over the same head (#637 `c1b2ece6` to `fc8c568e`).

  Each cost a turn of checking GitHub before acting.
- **Got in the way: the text-approval step before every push,** until the person dropped it (`reset-508-1`). #629 and #633 each went through three or four text revisions, because the head moved between approval and push.

## 2. Design and planning

- **Worked: rule-13 half pages before code.** `design-633-turn-1` and `design-b1-2` were each read by critic and a peer, and each read changed the design before any code: critic's blocker on the second reader in `apps.mjs`, gpt's kept block, critic's INV-6 and emitter sweep for B1a.
- **Didn't work: the #633 design answered "which turn counts" for the cases we listed, not the class.** The integrator, then critic's fresh subagent, found five more cases over six rounds: restart, Retry, the expiry at the turn's end, the kept block, then the sweep dropping what `main` keeps. Each was state a decision read from memory, or a recomputation that ignored the current need. A design row that said "every decision `needs` makes reads only the store, and a restart never drops a need `main` keeps" would have named the class on day one.
- **Worked: re-planning on evidence.** Moving client-side virtualization ahead of the server window (`reset-508-1`, #712) let B1b go first and turned B1a into a later step. The B1 design note was rewritten, not thrown away (`designs/508/b1-view-state.md` on `feat/508-b1b-view-state`).
- **Would change:** a stopgap such as #633 should be scoped as "equal to `main` except the named fixes", with `main`'s behavior as a written table in the design. Most of my rounds were rediscovering where `main` differed.

## 3. Execution

- **Flowed: failing-first specs with mutants.** Every #629 and #633 fix had a red spec at the commit before, and the mutant runs caught my own gaps. For example, the `lastTurnId` mutant first looked unkilled until I fixed my grep filter, and needAppSend's guard got its own spec.
- **Waited: CI and the review chain per push.** One change went through CI (20 to 40 minutes), critic's read, a text approval, a push confirm, CI again and a label confirm. A flaky epoch test (#713) cost #633 a rerun and a confirm.
- **Why defects reached the integrator (#629, #633):** my specs tested the case I fixed, and readers read what I showed them. The integrator's reviewer probed the neighbors: a reply arriving after `close()` (#629), a failed turn followed by an app card (#633). critic's fresh-subagent pass, added late in the sprint, found the same class before the integrator four times on #633. That pass, run earlier, is the change that worked.
- **My own misses:**
  - a commit header over 100 characters, three times;
  - an import inserted inside a multi-line import;
  - zsh not splitting `$S`, which made Playwright find no tests;
  - in #629's first fix, `held` let a post-close reply through, which critic caught.
- **Rebases cost real time:** #638's lint rule forced #629's rebase and re-approval, and #630 conflicted with #633 in `server/index.mjs`. CI tests the merge with `main`, so a rule landing on `main` can fail a green PR.

## 4. Harnesses and quota

- **I ran on Claude Code all sprint, so I can't speak to the Codex and Antigravity harnesses from inside.** What I saw from my side: the room's messages from gemini sometimes linked files with `file://` paths on this machine (#631's hand-backs). Mixed backends also meant a delivery's transcript went unchecked: the UAT report marked `delivery-dropped` "unverified on Claude Code" for every agent (needsnav run `2026-11-02T16-55-36-needsnav`).
- **Background processes beat polling.** `gh pr checks --watch` in the background (rule 19) replaced timers and cost one turn when CI finished, not one per poll. A background Explore subagent and the sweep subagent for #629 kept long file reads out of my context.
- **Context was the quota cost I could see:** this session was compacted once, and long reads (`thread.mjs`, the integrator's reviews) were the largest items. Reading only the lines needed, and delegating sweeps, would have saved most of it.
- **Would set up differently:** one harness per role for a sprint, so a mid-sprint switch doesn't change who can run background commands or subagents.

## 5. Postbox itself

- **A block that the person answered couldn't be updated until the answer reached my turn.** `design-b1-1` refused revision 2 three times ("answered revision 1 … reaches you when this turn ends"), so I posted `design-b1-2` instead, which split the history. `pr633-review-texts-1` did the same.
- **The answered-block lag also made status drift.** An agent couldn't see a confirm's answer until its next turn, so "the person confirmed" in one agent's message raced the confirm's owner running it. That's critic's #629 and #633 "pushed" lines.
- **No reply marker for asks (#634)** would have saved several "our messages crossed" turns.
- **A thread per PR (#507, #637)** wasn't available until late. The main room carried every PR at once, so each wake reloaded all of them.

## 6. For the next sprint, in order

1. **Run critic's fresh-subagent adversarial pass on a design's first code head,** not after the integrator. Make "equal to `main` except the named fixes, as a table" part of every stopgap's rule-13 note.
2. **One topic thread per PR from day one** (#637 merged), with the hand-back in that thread, so crossed messages and stale status stop.
3. **Approve once per push,** with texts inside the confirm (as `reset-508-1` adopted), and let a mechanical rebase keep its sign-off. Rebase onto `main` before review, not after, so a new lint rule doesn't reopen approvals.
