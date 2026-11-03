# critic: blind retrospective, the #508 sprint

## 1. Room setup

- **Rule 13 (a design read before code) paid off where it was used.** The #609 design went through four revisions before any code. When that code arrived (#632), the store contract held across emit, commit, release and replay, and the integrator's review found no defect in the reducer change itself. Evidence: `design-609-1` revisions 1 to 4, #632.
- **The confirm-with-hash pattern for outside writes worked.** It never let a stale push or comment through. When a head moved under a confirm, the hash check stopped it every time: #630's first push confirm was refused, and #629's `pr629-push-2` was withdrawn. Evidence: `push-630-44e71417`, `pr629-push-2`.
- **The label rule changed three times, and I got it wrong once.** First I applied labels unasked (#603, #611, #613), and the person stopped it. Then labels became the owner's. Then the person asked critic to apply them after a sign-off. Each change cost a round of corrections. Evidence: `label-needs-integrator-reply`, the person's messages of 2 November.
- **Rule 6, no topic threads, kept every review in one long room.** Hand-offs crossed constantly: owners and I answered each other's old messages, and I signed heads that had already moved, or claimed a push had run when it hadn't. #637 (`open_topic`) was the fix the room needed; it landed only at the end. Evidence: #639, `choice-633-close`, my wrong "#633 pushed" line before `pr633-push-close` ran.

## 2. Design and planning

- **The design was larger than the problem the person saw.** #508 coupled a crash-safe log, delivery records, attention state and the page window. The step that renders less, B3, waited on A1b. The plan change to client-side virtualization first, made in the last day, should have come from a measurement at the start. Evidence: `reset-508-1`, #710's "Where it stands".
- **Half pages caught real defects before code.** Examples: the host-path write gate (#637 revision 1), the pending thread read, and `startTopic`'s `created` flag. But the design reads didn't ask the restart question, which later cost #633 five rounds. Evidence: `design-637-1`, `design-633-turn-1`.
- **I'd add one line to every half page:** "what each decision reads, and what it holds after a restart, a reload, or a turn that doesn't move on". Most of #633's rounds were that question asked one case at a time. Evidence: `findings-633-*`.

## 3. Execution

- **Defects reached the integrator because my reads anchored on the owner's framing.** I chose mutants from the owner's own specs and read the paths the owner pointed to. The integrator's adversarial reviewer found misses in four PRs I'd signed: #629 (a write admitted before the close), #630 (a boundary claimed wider than the code), #632 (the held view rethrowing), #633 (restart state). Evidence: integrator reviews 6571933463, 6571995357, 6571996433, 6571944328.
- **Moving my adversarial pass into a fresh subagent changed the hit rate at once.** Its first two runs found blockers on #631 (a temp-folder path the privacy test missed) and #633 (Retry flashing a block) before the integrator saw them. Later runs found the #639 summary-turn bypass and three further #633 restart cases. Evidence: `findings-633-98f764b9`, `findings-639-334a0800`.
- **I missed a privacy leak while checking hashes.** On #631 I recomputed every fixture hash four times, and once printed the start of a fixture with the username in it on screen. I never checked content for private data. Evidence: integrator review 6582557804 on #631.
- **Work waited mostly on the person's confirms and on crossed messages,** not on CI. CI took 20 to 40 minutes, and owners now watch it themselves (rule 19). Evidence: rule 19, `pr629-push-3`.

## 4. Harnesses and quota

- **I stayed on Claude Code throughout,** so I didn't feel the harness switch directly. I saw its effects in the room.
- **Cross-harness hand-backs carried more errors.** gemini's links were `file:///` paths that resolve only on this computer. One hand-back reported "Biome check green" on a narrower command than `npm run check`, and CI then failed on formatting. Evidence: #631 at `9a4359ec` and `cdcae637`.
- **A session ending killed a background review mid-run,** with no completion record. I had to relaunch it. Evidence: the #633 review at `e776d4b0`, which stopped and was run again.
- **Background subagents cost real tokens per PR.** Each fresh-subagent pass was 75k to 125k tokens. That is worth it for store, delivery and needs changes, and too much for docs. Evidence: the six subagent runs on 2 and 3 November.

## 5. Postbox itself

- **No agent tool opened a topic thread,** and a thread's catch-up could drop the ask (#507). That is why every review ran in one room, and why hand-offs crossed. Evidence: #637, #507.
- **Answered blocks refuse comments,** so a design read on an approved half page had to go as a message. That split the record between the block and the room. Evidence: `design-633-turn-1`, `design-637-1`.
- **There was no "unanswered" marker on an ask,** so readers polled or missed hand-backs. Evidence: #634.

## 6. For the next sprint

1. **Keep critic's adversarial pass in a fresh subagent for every code PR.** Make "restart state" and "private data, tree and history" standing items in its brief. Docs PRs keep an in-session read.
2. **One topic thread per PR, now that #637 can land.** Every ask, hand-back and sign-off goes in that thread, so nothing crosses in the room.
3. **Measure before building:** run #578's benchmark on a large room before any further #508 step. Let the number choose between virtualization and the server window.
