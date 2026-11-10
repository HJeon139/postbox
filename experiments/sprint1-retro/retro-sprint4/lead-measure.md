# Blind retrospective, sprint 4

## 1. Room setup

- The measurement role was concrete enough to produce two merged foundations: the key-to-frame tool in PR #777 and the PF-1 plus snapshot-stall measurement in PR #783. Those two heads gave later performance work one shared vocabulary and one repeatable harness.
- Pairing build work with independent recorded-data checks helped when the behavior depended on a browser or a real room shape. Evidence: `sprint4/712a1-smooth-probe-mac-c60602c0.jsonl` and the four `sprint4/959-*-trace*.txt` assets supplied observations that the build-side probes could not claim alone.
- The room description fell out of sync with the actual backend and effort, which made the operating setup harder to trust. Evidence: room messages `it_cufqUQDk` and `it_Re5tCc2y` show the saved persona configuration disagreeing with the role description.
- A shared GitHub identity obscured branch ownership during the close, so the state had to be reconstructed from worktrees and agent reports instead of `--author`. Evidence: room message `it_hFG7Kxrh` records that limitation explicitly.

## 2. Backlog grooming, estimation and planning

- Splitting #508’s independent actions worked: PRs #742, #761 and #772 delivered fixture privacy and the commit hook separately, while PRs #762, #743 and #771 delivered #713, #729 and #730 separately. Each could merge without waiting for the whole performance program.
- The planning did not leave enough integration time for the performance tail. Evidence: PR #1181 ended the sprint approved but with failing CI, and PR #1185 ended with failing CI and no approval.
- Recorded room shape exposed a need that the original PF-1 plan did not include: switching into a long conversation. Evidence: commit `656faf4d` adds the sprint 4 room seed after the switch bench had already grown across nine pushed commits.
- The performance backlog mixed measurement, product fixes and budget policy under #508, #1150 and #1166. Evidence: PR #777 is a tool, PR #1181 changes transcript layout behavior, and PR #1185 is a release gate; treating them as one stream hid their different review risks.

## 3. Execution

- The test-first tool path flowed through review and merge. Evidence: PR #777 merged the key-to-frame tool and PR #783 merged the PF-1 and snapshot-stall measurement, including the generated-room sizes and recorded before/after evidence.
- The held-room optimization reached a product fix and a design note, but its delivery state regressed after approval. Evidence: PR #1181 is at `300095fa` with an approved label and failing CI in `retro-sprint4/pr-check.json`.
- The budget gate became too large to stabilize comfortably at the sprint boundary. Evidence: PR #1185 is at `4f62dbfa`, contains 22 commits beyond its base, and has failing CI in `retro-sprint4/pr-check.json`.
- Exploration ran ahead of reviewable delivery on room switching. Evidence: `feat/508-switch-bench` is pushed at `656faf4d` with nine commits beyond its base but has no PR, while `wip/switch-needs` remains a local alternate head at `7c3a71ff`.
- Temporary probes found useful causes but accumulated cleanup work. Evidence: the uncommitted `zz-leak-probe`, unload probe, view-jump instrumentation and stylesheet experiment remain in four detached probe worktrees at the close.

## 4. Postbox itself

- Long-room scrolling still required repeated manual tracing across browsers instead of one diagnostic capture. Evidence: issue #959 produced separate Chromium, Firefox, append, lag and wheel-trace assets plus four follow-up drafts.
- Conversation switching lacked a standard performance measure, so the sprint had to build one after the behavior became important. Evidence: commits `69f5011a` and `941ca38c` introduce the switch bench and the cross-project needs case.
- Comparing two revisions was awkward enough that the key-frame tool needed an explicit second-checkout mode. Evidence: commit `b07238eb` adds `--app` solely to measure another checkout’s Postbox.
- The persona UI allowed descriptive state and executable state to diverge. Evidence: room messages `it_cufqUQDk` and `it_Re5tCc2y` show five role descriptions still naming an old backend after their saved settings changed.

## 5. For the next sprint

- First, finish the budget gate before starting another performance implementation: reduce PR #1185 to a green, reviewable head and rerun its exact 1,000, 10,000 and 100,000 item cases.
- Second, turn the switch-bench exploration into one rebased PR with one chosen head, then archive the alternate. Evidence: pushed head `656faf4d` and local head `7c3a71ff` currently represent overlapping versions of the same measure.
- Third, require a recorded-room and cross-browser evidence row before a performance PR is labeled ready. Evidence: the #959 trace assets and `sprint4/712a1-smooth-probe-mac-c60602c0.jsonl` found behavior that synthetic build-side checks alone did not establish.
