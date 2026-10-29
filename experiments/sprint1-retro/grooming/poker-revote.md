# Estimation re-vote (one round), 27 October 2026

Same scale and references as poker-round2.md. Round 2's cards are now revealed in the room. Re-vote only these items. Read the reasons below from the high and low cards, then write `.scratch/grooming/revote-<your handle>.json` in the same format ([{ "item", "card", "driver" }]), don't open the others' re-vote files, and post only "done" with an @-mention of researcher. If cards still differ by more than one step after this, the item goes to the person as `?`.

Where round 2 said "split", the item is now cut into the parts proposed, and each part gets its own card.

## #466 + #458 + #467 (round 2: split, 13, split) — card each part
- `#458-cancel`: agents cancel their scheduled wakes; schedule_wake returns a schedule ID.
- `#466-retry`: classify network failures as transient; retry a wake when no tool call had started; #467's plain-words Kiro error.
- `#466-recovery`: after a tool call had started, run a recovery turn that says what had started.
Reasons: developer and gpt: together bigger than #423. critic (13): three behaviors on one schedule ID; cut #458 out first if it reads bigger.

## #472-step4 (round 2: ?, ?, 13)
Low (developer, critic): whether each backend can take input mid-turn is what #470's spike answers; estimate after it. High (gpt): universal delivery across backend differences, states, pair-limit accounting, fallback, real runs.

## #424 (round 2: split, 8, 5) — card each part
- `#424-keys`: Enter wakes, Ctrl/Cmd+Enter notifies, editing a waiting message brings it back to the composer (after #427 and #472 step 4).
- `#424-scheduler`: the interrupt scheduler on each primary backend's low-cost model: structured output, never answers an open ask, visible decision with one-click undo, a fake for tests, fallback.
Reasons: developer: keys ~3, scheduler ~8. critic (8): model-backed scheduler on every backend plus principle-6 limits. gpt (5): reuses the notify and interrupt mechanisms built earlier.

## #464 (round 2: 8, 5, 13)
Low (critic, 5): install or upgrade the versioned host bundle on demand, reusing install.mjs's verified atomic install; a real remote run across a version bump. High (gpt, 13): standing consent, version negotiation, bounded retries, coexistence with old turns, remote verification. Middle (developer, 8): update-required classification, standing-consent setting, auto install and reconnect, fallback, security review.

## #404 (round 2: 3, 3, 8)
Low (developer, critic, 3): three small, specified fixes: refuse local rules for a host persona server-side, HARDENING in the UAT runner's ssh, a SECURITY.md change. High (gpt, 8): three separate security follow-ups across rule placement, hardened ssh args and remote argv exposure, with tests and docs.

## #417 (round 2: 8, 8, split) — card each part
- `#417-app`: read_message returns an app's code and check status to a reviewer on another host.
- `#417-files`: files and screenshots reach a reviewer's host, within REMOTE_LIMITS (leans on #85; screenshots on #95).
Reasons: developer and critic (8 whole): cross-host read_message plus file carrying, real two-host runs. gpt (split): app retrieval and file transfer are separate protocols.
