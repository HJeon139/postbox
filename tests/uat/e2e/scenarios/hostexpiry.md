# Host expiry: a permission card on a host that nobody answers

- persona: An engineer who runs an agent on a lab machine and sometimes walks away from a permission card. Wants Postbox to stop saying it needs them once the card can’t be answered, and wants the agent to know so it can ask again. Writes short messages.
- agents: critic
- place: critic=host1
- permission_modes: critic=ask
- project: Line counter
- conversation: Card left unanswered

A run with one host only (`--host`, once): @critic works on host1 in Ask me, so Claude Code asks before a command that writes a file, and runs a read-only one without asking. Run it with `--host-setting host1.permissionWaitMax=1min`, so the host stops waiting on an unanswered card after a minute. It’s there to make Postbox show #721’s fix: a card that expires leaves no “needs you”, and the agent hears in its next turn which request expired. Its own scenario, so it needs one host and adds no phase to `remotehosts.md`.

## Phase 1: A permission card nobody answers expires

- triggers: expired-card-no-need
- steps: 6

Ask @critic to run `date >> expiry-check.txt` and show the file’s last line. When its permission card appears, don’t answer it. Use a wait of 70 seconds: in this run its host stops waiting after a minute, so the card should then say nobody answered in time. Then the room shouldn’t say @critic still needs you. Ask @critic anything, such as what it’s working on: it should say that request to run the command expired, name the command, and offer to ask again. Don’t press Stop on that turn, since a turn you stop sends no such note.

## Phase 2: Asking again, and answering this time

- steps: 4

Tell @critic to ask again. When the new card appears, allow it once. The command should run once, adding one line to `expiry-check.txt`, and @critic should show that line. The room shouldn’t say @critic needs you afterwards, and the expired card should still read as expired, with no button.
