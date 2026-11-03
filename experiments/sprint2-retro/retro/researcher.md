# researcher: blind retrospective, #508 sprint

Written before reading anyone else's answer.

## 1. Room setup

- **The coordinator relayed too much.** Most hand-offs went out as my wake messages rather than room posts until the person stopped it on 2 Nov ("we should be using this room and conversation threads"); each relay cost a turn and duplicated context (my wakes to gpt, developer and engineer on 1 to 2 Nov).
- **Approvals attached to the wrong head, repeatedly.** The person approved `plan-427-470-1`, `-2` and `-3` for heads I had already moved; I re-asked three times in an hour (filed as a comment on #518). developer pushed #590 with an unapproved commit (`6452ec67`).
- **Room rules grew to 21, each after a miss** (`designs/508/room-rules.md`; rules 19 to 21 in #636). They helped, but they arrived after the work they govern.
- **No per-PR threads all sprint.** Rule 6 blocked them until #507; agents could not open a thread at all until #637 (#639). Everything ran in one room.

## 2. Design and planning

- **Scope moved under the work.** Redis was decided on 28 Oct and recalled on 31 Oct (#580); #608's 513 lines were rejected and split (#630, #711); #603 was closed for three smaller PRs; the server window was deferred for client-side virtualization on 2 Nov (#710, #712).
- **We built before measuring.** #615's own measurement says the original stall was painting, fixed by #565, and that #305 is "headroom, not a measured stall". B1 to B3 were planned without a benchmark on a large room.
- **Rule-13 design reads paid off** where they happened first (#609's design, critic's four conditions on delivery routes, #708), and cost a round where code came first (#597's undo, #633's five restart rounds).
- **My plan edits churned:** the AT-6 bound went 25%, 30%, then 25% again for different elements in one evening (`plan-427-470-1` to `-4`, #592).

## 3. Execution

- **Defects reached the integrator because nobody probed the neighbors before "ready".** Authors tested the case they fixed; critic read in the same session as the author's explanations. The integrator's adversarial pass found a regression in each second review: #597's Undo, #629's admitted writes, #632's held view, #633's restart cases, #639's lost message (integrator comments, 1 to 2 Nov). Moving critic's pass to a fresh subagent caught #631's leftover temp path and #633's Retry flash before the integrator did (2 Nov).
- **UAT lapsed.** The definition of done asks for the author's UAT run; none of #629, #630, #632, #633 attached one.
- **Each push cost about an hour of ceremony:** design read, two sign-offs per head, text approval, push confirm, CI (20 to 40 min), label confirm. A lint rule landing on `main` (#638) forced rebases, re-reads and re-approvals on #629.
- **Private data reached a public branch twice** (#586's `installationId`, #631's paths); hashes were checked four times, content never, until a test was written.

## 4. Harnesses and quota

- **Codex ran nine days without its instructions** (#584: an unsupported `turn/start` field) while the tests stayed green; gpt's dense hand-offs were blamed on the model first.
- **Antigravity's spike evidence was authored, not captured** (#631, first round): message ids sequential, the model echoing the fixture's words; it took three revisions to become evidence.
- **My own session ran on another model for a turn** ("ran on gemini-3.8-flash-medium, not the model you set"), and that turn produced a quiz with a made-up progress formula that the person rejected.
- **Quota ran out and most agents moved to Claude mid-sprint.** Context reloads on every wake, with seven agents in one room, are where it went: many turns were acknowledgements, crossed messages or stale deliveries (#594, #595).

## 5. Postbox itself

- **A held wake blocks every other message to that agent** (#594); my push requests to developer waited behind an unrelated wake.
- **Queued messages arrive after the author has superseded them** (#595); at least six of my turns were acknowledgement-only on 31 Oct.
- **Review blocks:** a "changes" marker with nothing changed (#593), no line numbers (#596), and an answer to an older revision applied silently (#518).
- **Agents can't open threads** (#637, fixed in #639), and a thread's catch-up dropped asks (#507).

## 6. For the next sprint

1. **Measure before building:** run #578's benchmark on a large room before any B-step or #305 slice, and set each step's acceptance from it.
2. **Fewer agents, one harness, one thread per PR:** three builders and critic on one harness with quota checked at the start; every PR in its own topic thread (#639), hand-backs per rule 19, no coordinator relays.
3. **Critic's fresh-subagent pass on every PR before "ready", and the author's UAT for conversation surfaces** (#659), so the integrator's review becomes a check, not the first adversarial read.
