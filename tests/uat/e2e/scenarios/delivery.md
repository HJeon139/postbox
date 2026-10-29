# Delivery: nothing dropped, nothing repeated without a label

- persona: A maintainer coordinating three agents on a release, who writes short messages, sends a second one before the first is answered, and leaves cards waiting while doing something else. Changes their mind about a queued message and edits it.
- agents: researcher, critic, developer
- seed: big-room
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

Baselines on `main`: #484’s dropped mention was fixed on `main` by #500 and #502, so there this phase shows `mention-past-cap` firing with `delivery-dropped` silent; the check’s firing is shown by its failing-first unit tests.

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
- host: developer
- host-triggers: wake-scheduled, wake-after-drop
- steps: 5

Ask @developer to schedule a wake for itself in two minutes, to check on the build, and then to cancel it. Say what the conversation shows.

### On a host

Ask @developer to schedule a wake for itself in two minutes. The runner drops the host’s link for 30 seconds over the moment it’s due. Say whether @developer woke.

## Phase 7: After a compaction (A2)

- triggers: compaction
- steps: 5

Compact @critic’s session from its quick panel. Then ask @critic what you asked it in phase 5, and where it would look if it isn’t sure.

## Phase 8: Changes while a delivery waits (A2)

- triggers: edit-while-waiting
- steps: 8

Give @critic a long job. While it works, send it a second message, which waits in the queue, and change it with the queued message’s Edit before @critic is free. Sent messages have no Edit, so use the queued one. Then, while @critic is busy again, ask @researcher to revise its review block “release-plan.md”. When @critic is free, ask it to quote your second message as it reached it, and which revision of the review it was told about.

This phase confirms DL-7 and AT-6. It has no baseline on `main`: queued messages aren’t items there, and revisions aren’t delivered as amendments until A2.
