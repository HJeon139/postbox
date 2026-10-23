# UAT plan: the Agents section, the Work view and the right pane

The validation pass for the next merge: #138 (the Work ledger), #142 (#105, agents in the sidebar) and the Work-pane rework of #138, together, on top of #127 (the Kiro CLI backend). It checks everything new, and everything that already worked, so the merge regresses nothing.

## Why

These changes move the controls you use most. Agent settings leave the top bar for the sidebar. A conversation’s work gets its own view, and the right pane holds more than threads. intent.md’s promise is one place to direct your agents, with nothing hidden or hover-only. So the pass checks that:
- every control is reachable, labeled and says its scope
- the Work view reports what happened, from tool calls and git, never from what an agent says it did
- the right pane never loses your place: drafts, scroll, streaming replies

## What’s new, and how each part is covered

| Feature                                                                   | Issue              | Headless check            | UAT doc and screenshot                                 | Real-agent check (`workroom.md`)                        |
| ------------------------------------------------------------------------- | ------------------ | ------------------------- | ------------------------------------------------------ | ------------------------------------------------------- |
| The Agents section: one row per agent, with its ring, state and open asks | #105               | `check-agents.mjs`        | `shell/rail/agents-section.md`; scene `agents-section` | `agents-section-members`                                |
| The quick panel: model, effort, mode and tools, each with its scope       | #105               | `check-agents.mjs`        | scene `agent-quick-panel`                              | `quick-panel-takes-effect`; phase 2                     |
| A slimmer top bar: the title and project in full                          | #105               | `check-header.mjs`        | `overview.png`, `rail.png`                             | `topbar-title-cut`                                      |
| A turned-off tool is refused visibly                                      | #104, with #105    | —                         | —                                                      | `shell-off-silent`; phase 2                             |
| The Work ledger: files, commands, version control, outside writes, effort | #132, #138         | `tests/work.test.mjs`     | `conversation/work-view.md`                            | `work-files-match-stream`, `work-commands-match-stream` |
| Restore and Remove, refused if the file changed since                     | #138               | `tests/work.test.mjs`     | `work-view.md`                                         | phase 3                                                 |
| Work in the right pane: compact, with an expand to full screen            | Work-pane PR       | `check-work-pane.mjs`     | `work-view.md`; scenes `work-pane`, `work-fullscreen`  | phase 1                                                 |
| The right pane split: a thread and Work, one above the other              | Work-pane PR       | `check-work-pane.mjs`     | scene `pane-split`                                     | `pane-split`; phase 3                                   |
| Thread full screen keeps the draft, the scroll and streaming              | Work-pane PR       | `check-work-pane.mjs`     | scene `thread-fullscreen`                              | `fullscreen-keeps-draft`; phase 3                       |
| Each reply’s work line opens Work at that turn                            | #138, Work-pane PR | `check-work-pane.mjs`     | `work-chip.png`                                        | phase 3                                                 |
| A Kiro CLI agent in a room                                                | #117, #127         | `tests/kiro-cli.test.mjs` | `sheets/new-agent.md`                                  | compatibility runs only (`--compat`)                    |

## What already worked: the regression set

- **The gate:** `npm run check`.
- **Every headless check:** `npm run check:browser`, which runs `tools/check-*.mjs` and `tools/checks/*.mjs` in parallel, each on its own ports. That includes app-send (#38), app-fullscreen (#45), check-transcript (#88, #91, #93), check-permissions (#66), check-commands (#67) and check-shell (#4, #26, #29, #69).
- **The demo screenshots with axe:** `tools/shoot-app.mjs` must report no violations in any scene.
- **The UAT doc screenshots:** `tools/shoot-uat.mjs`, with every scene captured, including the new ones above.
- **The real-agent scenarios:**
  - `scifact.md` and `hotpotqa.md`: the long-running regression pair.
  - `wikisearch.md`, `announcement.md` and `papersurvey.md`: M1’s exit check, so agents still pick blocks without being asked.
  - `workroom.md`: the new features.
  - Not `mixedroom.md`: UAT passes are Claude only. Mixed rooms and other backends get an occasional compatibility run (`--compat`), outside wave passes.

## Harness work before the run

Built on the integration branch, once the Work-pane PR landed. Each check has a test in `tests/uat-checks.test.mjs`, and the driver actions were smoke-tested against the demo. The mock agent has no model, effort or mode choices, so those are only exercised with real agents.

**Driver and tester actions** (`tools/uat/driver.mjs`, `tools/uat/tester.mjs`):
- `agent_panel {target, model?, effort?, mode?, shell?}`: opens the agent’s row in the Agents section and sets those, by clicks.
- `pane {open: 'work' | 'thread', item?}` and `fullscreen {pane}`, which closes it again with Escape. `thread_reply {text}` answers in the thread open in the pane.
- `restore {file}`: in the full Work view, Restore or Remove, then confirm.
- `fullscreen_draft {text}`: opens the thread full screen, types without sending, and leaves full screen, for the draft check.

**Checks** (`tools/uat/checks.mjs`):
- `work-files-match-stream`: every file an agent changed with Edit or Write, per the turn streams, is in the ledger. The ledger’s line counts are covered by `tests/work.test.mjs`, which replays recorded turns; a Bash-made change isn’t seen, which the Work view says.
- `work-commands-match-stream`: every Bash call in the streams appears as a command, with the exit code and the agent the stream gives.
- `agents-section-members`: the section lists the conversation’s members, and a topic thread’s section lists the thread’s.
- `quick-panel-takes-effect`: after the panel changes a model or effort, the agent’s next turn runs with it, per its `init` and its arguments.
- `shell-off-silent` (#104): with Shell off, a Bash attempt shows as a refused step with a reason, and the reply doesn’t claim it ran.
- `topbar-title-cut`: at 1280 px, with two agents, the title and project aren’t truncated.
- `pane-split`: with a thread and Work open, both are visible, each with a usable height.
- `fullscreen-keeps-draft`: a draft typed in full screen is still in the composer after leaving it, and the transcript is scrolled where it was.

## Run order and cost

1. The gate and every headless check, on each PR alone, then merged. Fix what fails before anything costs money.
2. `shoot-app` with axe, then `shoot-uat`, and commit the screenshots.
3. The real-agent scenarios, each started a few seconds apart, so their run folders don’t collide. Expect about $10 for the three exit scenarios, $20–40 for `workroom`, and $20 to $80 for `scifact` and `hotpotqa`.

## Exit criteria

- Everything in steps 1 and 2 passes, and axe reports no violations.
- `workroom.md` runs all three phases with no new defect in the features above, and every new check is quiet or explained.
- The regression scenarios show no defect that main doesn’t have.
- M1’s exit check stays at or near 100%.
- Every finding is filed (when it isn’t a duplicate) or declined, with evidence and its intent.md reason.
