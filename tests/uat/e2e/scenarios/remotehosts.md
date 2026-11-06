# Remote hosts: three agents on three machines, and what happens when the connection breaks

- persona: An engineer who keeps two lab machines for long jobs and works from a laptop. Wants agents on each machine to work together the way they do on one, checks where each command really ran, and isn’t shy about pulling a cable to see what breaks. Writes short messages.
- agents: researcher, critic, developer
- place: researcher=host1, critic=host2, developer=local
- permission_modes: critic=ask
- project: Line counter
- conversation: Across machines

A run with hosts only (`--host`, twice): @researcher works on host1, @critic on host2, and @developer on this computer, all on Claude Code. @critic is in Ask me: Claude Code asks before any command that changes something, such as one that writes a file, and runs a read-only one (`uname`, `pwd`, `ls`, `sleep`, `date`) without asking, by its own rule, here as on a host. So a read-only command of @critic’s with no permission card isn’t a defect. Each phase is there to make Postbox show one part of #120 working: a turn on each machine, blocks and a permission card from a host, a file you attach reaching an agent on another machine, agents waking each other across machines, Stop on a host, and the connection breaking on purpose. Watch for an agent that says it ran somewhere it didn’t, a card or an answer that’s lost, a reply that shows a line twice after a reconnect, and a host that never reads Connected again.

## Phase 1: A turn on each machine, with a block, a review and a slow permission card

- triggers: turn-on-each-place, remote-block-answered, remote-review-answered, remote-card-after-a-minute
- steps: 12

Ask each agent, one message each, to run `uname -n` and `pwd` in its folder and tell you both in one line: @researcher, then @developer, then @critic. Their machines or folders should differ, and none should claim another’s. Then ask @researcher to offer you three names for a small shell script that counts the lines in the text files of a folder, for you to pick one, and pick one. Ask it to put the script’s draft, about ten lines, up for you to approve before it writes it to a file: request a change with a comment on one line, then approve the version after. Last, ask @critic to run `date > card-check.txt` in its folder: it writes a file, so Claude Code asks. When its permission card appears, wait more than a minute (wait 70 seconds), then allow it, and check that the command ran.

## Phase 2: An attachment, agents waking each other, and Stop on a host

- triggers: remote-attachment-read, cross-host-wake, remote-stop-says-jobs, remote-stop-no-process-left
- steps: 12

Attach a screenshot of @researcher’s draft and send it to @critic, asking what the script does: @critic is on another machine, so it has to read the image there, and it should describe it, not say it can’t open a file. Then ask @critic to send its one-line suggestion straight to @researcher, and @researcher to tell @developer straight back whether it agrees, without you in between: agents on three machines waking each other. Last, ask @researcher to start a background command in its folder: a shell loop that appends the time to `heartbeat.log` every 5 seconds for 3 minutes, using only `sleep` and `echo`, nothing over the network, and to check the file every 20 seconds and tell you how many lines it has. About 30 seconds into that turn, press Stop (an interrupt that stops). On a host, a background job stops with its turn: before Stop, the composer should say so, and Postbox shouldn’t ask whether to keep it running. Then ask @researcher whether `heartbeat.log` is still growing: it shouldn’t be.

## Phase 3: Breaking the connection on purpose

- triggers: fault-kill-ssh, remote-card-while-disconnected, fault-restart-postbox, fault-kill-daemon
- steps: 12

Ask @critic to run `sleep 20; date >> card-check.txt` and then show the file’s lines. When its permission card appears, kill its ssh connection first (fault kill-ssh, target host2), and only then allow the card: Postbox should show host2 reconnecting and then Connected again on its own, and the command should run once, after your answer, adding one line. Then ask @researcher to run `for i in 1 2 3 4 5 6; do echo $i; sleep 10; done` and summarize what it printed, and about 15 seconds into that turn restart Postbox (an interrupt with fault restart-postbox): the reply should come back from the start once Postbox is up, with each number once, and end done. Last, ask @researcher for the same loop again, and about 15 seconds in kill Postbox’s daemon on host1 (an interrupt with fault kill-daemon, target host1): the host should reconnect on its own, and the reply should finish with each number once.

## Phase 4: An older Postbox on the host

- triggers: host-staged-older, host-turn-waited-install, host-auto-installed
- steps: 8

Play this phase on its own, with `--phases 4 --stage-host-version <tag>`, an older release tag such as v1.16.1, beside the same two `--host`s: before the run, the runner installs that older Postbox on host1 instead of this one, as someone who updated Postbox on their laptop but not on the host has (#464), and turns on host1’s consent for Postbox to install its own version there by itself. A run with that option plays no other phase, and one without it doesn’t play this one. Send @researcher, on host1, one message asking it to run `uname -n` and tell you what it printed. That first turn finds the older Postbox there. Postbox installs its own version by itself, and the turn waits for it: its line beside @researcher says “Installing Postbox <version> on host1…”, and host1’s card in Settings › Hosts says the same. Don’t press Install…. The turn should then run there and tell you what it printed, and host1’s card should say Postbox installed that version there by itself. Once host1’s card reads Connected, send @researcher on host1 a second message asking the same; that turn should run there too. A first turn that fails, a second turn that fails, a card that never reads Connected, or Postbox installing it more than once is a finding.
