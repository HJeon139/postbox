# Assets across machines: a host agent shares files, and the connection breaks

- persona: An engineer whose reviewer agent runs on a lab machine, and who wants a plan written here to be read and revised there, then pulls the cable mid-read to see what survives. Writes short messages.
- agents: researcher, critic
- place: critic=host1, researcher=local
- project: Login cleanup
- conversation: Plan across machines
- steps: 12

A run with one `--host`: critic works on host1, and researcher on this computer, both on Claude Code, with the six asset tools (#516 S3). The report names the host version the run installed, so a pass is tied to this pull request’s host code: the broker’s refusal while disconnected is host code (#464). Each phase confirms rows of #516’s S3 design; the rows no run can reach are listed in the README, “Assets”.

## Phase 1: Sharing across machines

Ask researcher to publish a five-bullet plan, `notes/plan.md`. Ask critic to list the conversation’s assets, read the plan, and publish a version 2 from base 1 that adds one bullet. Then ask researcher to change the first bullet, writing from base 1 on purpose, and to quote Postbox’s answer.

Pass if critic, on the host, finds the plan by listing, quotes researcher’s lines, and publishes version 2; and researcher’s write from base 1 is refused, naming version 2. Fail, and file it, if critic can’t reach the plan, or a version is published from a stale base.

## Phase 2: Text only on a host

Ask critic to write a short file in its folder on the host and publish it as an asset with `path`.

Pass if it’s refused, saying that on a remote host write_asset takes text, and critic can then publish the same content as text. Fail, and file it, if the path is read, or no reason is given.

## Phase 3: A long read across a dropped connection

- triggers: fault-kill-ssh

Ask researcher to publish `notes/cases.md`: 150 numbered lines of test cases, each about 300 characters, the last one ‘END OF CASES’. Ask critic to read it in full, part by part, and to quote the last line. While critic reads, kill its ssh connection (fault kill-ssh, target host1).

Pass if host1 reads Connected again on its own, critic’s turn keeps working, and critic quotes ‘END OF CASES’. Say from the run’s records whether a read was sent again: if none was, the resend path is unverified here, and the host spec decides it (tests/asset-tools-wiring.test.mjs). Fail, and file it, if a part comes back cut short, or the turn stops.

## Phase 4: A call while the host is disconnected

- triggers: fault-restart-postbox

The broker on the host refuses a call only while its host is detached, and only a turn that’s already running can make one then: a new turn waits for the host’s welcome before it starts (server/remote/turns.mjs). So the call has to come from inside one turn that spans the fault.

Ask critic, in one turn, to list the conversation’s assets 15 times, running `sleep 1` in its folder between each, and to quote every answer word for word, numbered. A restart keeps Postbox down for about 2 seconds, so calls a second apart land one inside it. About 8 seconds into that turn, restart Postbox (an interrupt with fault restart-postbox). The turn keeps running on host1 while Postbox is down.

Pass if the answers critic got while Postbox was down, by the run’s records of the restart and of host1’s reconnect, say Postbox isn’t connected to this host, and to try again in a few seconds if it’s reconnecting, or that Postbox may be closed if it stays this way; and the answers after host1 reads Connected again list the assets. If no call fell inside the restart, say so: the refusal is then unverified here, and tests/remote-broker.test.mjs decides it. Fail, and file it, if a call made while Postbox was down lists the assets, or its answer says only to wait until Postbox is open, or a call after the reconnect fails, or the turn stops.
