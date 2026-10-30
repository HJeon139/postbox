# Testing strategy for #508: acceptance scenarios

Two targeted scenarios, plus the triggers, checks, seeds and runner changes they need. They follow `tests/uat/e2e/README.md`: **a run confirms a fix; it doesn’t decide it.** Each phase names the deterministic test that decides its step (layer 1 or 2) and the requirements it confirms (layer 3). A requirement counts as confirmed in a run when its phase’s triggers fired and its checks stayed silent.

Requirement ids, and the trigger and check each requirement names, are from `requirements.md`, “Acceptance, test first” (revision 4.3, approved). Step names (A1–A4, B1–B3) are from `design.md`, “Rollout” (revision 11.2).

---

## File 1: `tests/uat/e2e/scenarios/delivery.md`

```markdown
# Delivery: nothing dropped, nothing repeated without a label

- persona: A maintainer coordinating three agents on a release, who writes short messages, sends a second one before the first is answered, and leaves cards waiting while doing something else. Changes their mind about a queued message and edits it.
- agents: researcher, critic, developer
- seed: big-room
- launcher: tools/uat/fault-launcher.mjs
- steps: 50
- conversation: The release, in a long room

All three agents start in a room seeded with about 1,000 items (`- seed: big-room`), so catch-up has to leave things out. The run checks that every message addressed to an agent reaches it: held behind a card, buried past the catch-up cap, sent while the agent works, or resent after a turn that failed before any output. A repeat must say it’s a repeat. The fault launcher fails one chosen turn before any output; the phase that needs it turns it on.

## Phase 1: Two wakes held at once (A1)

- triggers: held-behind-card, held-released
- steps: 8

Ask @critic and @developer to settle the version number between them, by mentioning each other until they agree, and ask @researcher and @critic to do the same for the changelog wording. Don’t answer the first “allow another wake?” card when it appears. Wait until a second pair is held too, then say what the conversation shows is waiting on you. Answer Allow on one card, then the other.

## Phase 2: A mention past the catch-up cap (A2)

- triggers: mention-past-cap
- steps: 6

The seeded room already holds a mention of @researcher as the oldest of more than 40 items since its last turn. Ask @researcher what it was asked for in this room and by whom, without saying where.

## Phase 3: A turn that fails before any output (A2)

- fault: fail-before-output researcher 1
- triggers: fail-before-output, resend-labeled
- steps: 6

Ask @researcher for the three riskiest items in the release. Its first turn after this message fails before it writes anything; say what the conversation shows. Ask it again only if the conversation tells you to. When it answers, ask whether it was given your request once or twice, and what told it.

## Phase 4: A message while the agent works (A2)

- triggers: urgent-note-delivered
- steps: 6

Give @developer a long job: list every public function in the project and what each returns. While it works, send it a correction (“skip the private modules”), with Enter, not Send now. Say when its work shows it read the correction.

## Phase 5: Your own queue (A3)

- triggers: person-queue-three
- steps: 6

While @critic works on a long job, send it three separate short messages. Edit the second, remove the third, and let the first two wait. When @critic is free, ask it how many messages from you it got in its last turn, and what the second one said.

## Phase 6: A scheduled wake (A4)

- triggers: wake-scheduled, wake-canceled
- steps: 5

Ask @developer to schedule a wake for itself in two minutes, to check on the build, and then to cancel it. Say what the conversation shows.

### On a host

- host: developer
- host-triggers: wake-scheduled, wake-after-drop

Ask @developer to schedule a wake for itself in two minutes. The runner drops the host’s link for 30 seconds over the moment it’s due. Say whether @developer woke.

## Phase 7: After a compaction (A2)

- triggers: compaction
- steps: 5

Compact @critic’s session from its quick panel. Then ask @critic what you asked it in phase 5, and where it would look if it isn’t sure.
## Phase 8: Changes while a delivery waits (A2)

- triggers: edit-while-waiting
- steps: 8

Give @critic a long job. While it works, send it a second message, which waits in the queue, and change it with the queued message’s Edit before @critic is free. Sent messages have no Edit, so use the queued one. Then, while @critic is busy again, ask @researcher to revise its review block “release-plan.md”. When @critic is free, ask it to quote your second message as it reached it, and which revision of the review it was told about.
```

**What decides each phase, and what it confirms**

| Phase | Decides (layer 1 or 2, written first, failing on `main`) | Confirms | Checks watched |
|---|---|---|---|
| 1 | #439’s and #326’s node tests: two held wakes behind one card; Allow delivers both | AT-1, AT-2, AT-3, AT-4 | `ask-dropped`, `needs-mismatch` |
| 2 | #484’s cases, including the oversized oldest mention; INV-9 | DL-1, DL-2, DL-4, DL-5 | `delivery-dropped`, `unlabeled-repeat`, `wake-text-clipped`, `thread-request-first` |
| 3 | The outcome matrix from recorded failing turns (conformance) | DL-3, DL-2 (labeled) | `marker-before-output`, `unlabeled-repeat` |
| 4 | The urgent-note test: delivered when the tool result returns | MD-2, DL-2 | `delivery-dropped`, `unlabeled-repeat` |
| 5 | A3’s record tests: Edit, Remove, no superseding of the person’s messages | AT-6, DL-6 | `queued-superseded` |
| 6 | #458’s and #466’s tests | SW-1, SW-2 | `delivery-dropped` |
| 7 | A recorded `compact_boundary` replayed through the Claude Code adapter (conformance) | CX-4 | `context-loss-unannounced` |
| 8 | A2’s amendment tests: a queued message edited before delivery arrives once, edited; a revised block reaches its reviewer once, as an amendment | DL-7, AT-6 | `unlabeled-repeat`, `delivery-dropped` |
| All | — | CX-1 | `thread-leak` |

**Baselines on `main`.** A phase confirms a step by running on the step’s branch. The last release before #497 and #500 is `d59e5e4b` (v0.42.0), where phases 1 and 2 still show #439’s and #484’s defects. Running it on `main` first shows its check fires only while `main` still has the defect. #484’s dropped mention was fixed on `main` by #500 and #502, so on `main` phase 2 now shows `mention-past-cap` firing with `delivery-dropped` silent, and the check’s firing is shown by its failing-first unit tests. Phase 8 has no baseline on `main`: queued messages aren’t items there, and revisions aren’t delivered as amendments until A2.

**Backends (DL-8).** The scenario runs four times, differing only in its header: all on Claude Code (a regular run), then with `--compat` and `- backends: researcher=codex`, `researcher=kiro-cli` and `researcher=antigravity-cli`. Phase 3’s fault applies to whichever backend @researcher runs on. Phase 7 runs on Claude Code only, until Codex’s compaction is wired up (#425); Kiro and Antigravity report a fresh session rather than a compaction, which the design’s marker reset covers.

---

## File 2: `tests/uat/e2e/scenarios/bigroom.md`

```markdown
# Big room: reading far back while agents keep writing

- persona: A lead reading back through a long room to find an earlier decision, while two agents keep posting. Jumps by link, by “Next that needs you”, and by searching, and scrolls up slowly through long messages.
- agents: researcher, critic
- seed: big-room
- steps: 30
- conversation: The release, in a long room

The room is seeded with about 1,000 items, so the page holds only a window of it. Agents keep writing while you read far back. Nothing you’re reading should move unless you scroll, a jump should land on its target, and a block revised far above should come back as its one live copy at the bottom.

## Phase 1: Reading back while agents write (B1, B3)

- triggers: window-paged-back
- steps: 8

Ask @researcher and @critic each for a long write-up, one after the other. While they write, scroll up slowly through the room to its first day, and say whether what you were reading ever moved without your scrolling. Then press End.

## Phase 2: Jumps (B2, B3)

- triggers: jump-outside-window, needs-far-back
- steps: 8

Open the link to the seeded room’s first decision (the run gives it to you). Then ask @critic to put a choice to you, and before answering, scroll far up and press “Next that needs you”. Say where each one landed.

## Phase 3: A block revised far above (B2)

- triggers: move-from-unloaded
- steps: 6

The seeded room holds a review block from @researcher near its start. Ask @researcher to revise that block. Without scrolling up, say where the new revision appears and what is left where the old one was.

## Phase 4: Search and switching (B3)

- triggers: search-outside-window, switch-conversations
- steps: 8

Search for a word that only appears in the seeded room’s first day, and open the result. Switch to another conversation and back while @critic is writing, and say whether anything it wrote is missing or shown twice.
```

**What decides each phase, and what it confirms**

| Phase | Decides | Confirms | Checks watched |
|---|---|---|---|
| 1 | The 13 scroll regressions (Playwright specs) | PF-3 | `view-moved` |
| 2 | Jump specs (Playwright) | PF-4, AT-4 | `needs-mismatch`, `needs-jump-missed` |
| 3 | The move-from-an-unloaded-page spec | PF-6 | `updated-app-far-up`, extended from apps to blocks |
| 4 | Search and switch specs; B2’s replayed-chunk test | PF-5, PF-8 | `stream-gap-or-dup`, `page-errors` |
| All | App-check spec for an unopened thread | PF-7 | `check-starved` |

PF-1 and PF-2 (performance) aren’t in either scenario. Real agents add noise and nothing to measure, so they stay in Playwright specs on seeded rooms.

---

## Triggers, checks and seeds to add

Each one carries the requirement ids it serves, beside today’s `issue` field, so a run’s coverage table can be read per requirement. Each is tested from a run’s recorded records, never from results written by hand (#451).

**Every check reads only what `main` already records:** items, sessions, the agents’ raw streams and the page’s probes. None depends on the new delivery records, because each must first run on `main` and catch the defect there, before the step that fixes it. A check may read records as extra evidence once they exist.

**Triggers** (in `tools/uat/triggers.mjs`)

| Trigger | Requirements | Postbox showed that |
|---|---|---|
| `held-behind-card` | AT-1 | two deliveries were held, open at once, behind cards |
| `held-released` | AT-1, AT-2 | answering a card delivered every delivery it held |
| `mention-past-cap` | DL-1, DL-5 | an addressed item older than the catch-up cap reached its agent |
| `edit-while-waiting` | DL-7, AT-6 | a delivery changed while it waited (a queued message edited, or a block revised) and reached its agent once, in its changed form |
| `fail-before-output` | DL-3 | a turn failed with no output and its deliveries went back to waiting |
| `resend-labeled` | DL-2, DL-3 | a resend reached the agent with its label |
| `urgent-note-delivered` | MD-2 | a delivery reached a working agent on a Postbox tool result, and the turn went on |
| `person-queue-three` | AT-6, DL-6 | three of the person’s messages waited for one agent at once |
| `wake-scheduled`, `wake-canceled`, `wake-after-drop` | SW-1, SW-2 | as named |
| `compaction` | CX-4 | a backend compacted a session’s context (`compact_boundary` on Claude Code) |
| `window-paged-back`, `jump-outside-window`, `needs-far-back`, `move-from-unloaded`, `search-outside-window`, `switch-conversations` | PF-3 to PF-8 | as named, read from the page’s probes |

**Checks** (in `server/room-checks*.mjs`, which `tools/uat/checks.mjs` runs). Names in plain code already exist on `main`, or come with PR #511 (`thread-request-first`); the rest are new.

| Check | Requirements | Looks for |
|---|---|---|
| `delivery-dropped` | DL-1, SW-2 | an item addressed to an agent (a mention, an allowed wake, a queued message, a due scheduled wake) that never appears in that agent’s raw prompts or tool results by the end of its next two turns. Where delivery records exist, also one closed other than delivered, superseded or expired |
| `unlabeled-repeat` | DL-2, INV-4 | the same `(to, sourceId, rev)` in two prompts, the second without the resend label, read from the agents’ raw prompts |
| `marker-before-output` | DL-3, INV-6 | a session marker that moved in a turn that produced no output |
| `ask-dropped` | AT-1 | a wake the limit held, seen as a hop item or a held line, that leaves the page and the state without the person answering it and without reaching its target |
| `needs-mismatch` | AT-4 | rings and “Next that needs you” disagreeing with the open asks |
| `queued-superseded` | AT-6 | a person’s queued message superseded |
| `thread-leak` | CX-1 | a topic thread’s text in another agent’s prompt, unless the person sent it there |
| `context-loss-unannounced` | CX-4 | a turn after a compaction whose envelope doesn’t say earlier messages may have been summarized |
| `stream-gap-or-dup` | PF-5 | an item missing from, or shown twice in, a window after a switch or reconnect, read from the page’s probes |
| `view-moved` | PF-3 | what the person was reading moved without a scroll, read from the page’s probes |
| Existing: `wake-text-clipped` (DL-1), `thread-request-first` (DL-4), `needs-jump-missed` (AT-4, PF-4), `updated-app-far-up` (PF-6, to be extended to blocks), `check-starved` (PF-7), `page-errors` (PF-5) | | reused, as `requirements.md`, “Acceptance, test first”, maps them |

**Seeds and runner changes**

- **`- seed: big-room`:** a generated room of about 1,000 items, with a mention of @researcher as its oldest addressed item, a review block near its start, and a decision with a known link. It is generated rather than copied from a real room, so no project’s content reaches the tester model, and runs are repeatable.
- **`tools/uat/fault-launcher.mjs`:** like `claude-launcher.mjs`, it starts the real CLI and passes its stream through. With `- fault: fail-before-output <agent> <n>` it kills the CLI at that agent’s nth turn, after its first session event and before any assistant output. That is the case gpt and gemini found saves the prompt first. Codex, Kiro and Antigravity need a binary override like `POSTBOX_CLAUDE_BIN` where they lack one.
- **Host link drop:** phase 6’s host variant needs the runner to cut the host link for a set time. Host mode has recovery tooling (`tools/uat/hosts-recovery.mjs`); whether it can drop the link on cue is unchecked.
- **Not covered here:** MD-1, MD-4 and MD-5 ship with the later modes step, and AT-5 has its own issue (#492); each gets its phases then. AT-7 (an Add card held as an ask, not dropped) fits phase 1 once the design gives it a step. A restart of Postbox in the middle of a host turn (`restart-mid-host-turn`) needs a runner action that doesn’t exist; until then, a node test decides it alone.
