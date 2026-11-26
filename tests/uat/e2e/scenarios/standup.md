# Standup: a sprint that stops after everyone has reported

- persona: A developer who gives a small team of agents a two-step sprint with a board and a standup between the steps, then steps away for ten minutes and expects the sprint to have gone on without them. Sends each message exactly as this scenario words it. While away they send nothing, relay nothing and prompt nobody; they answer only what’s theirs to decide, such as a permission card.
- agents: alpha, developer, critic, researcher
- permission_modes: alpha=auto, developer=auto, critic=auto, researcher=auto
- files: nightly
- project: Slugs
- conversation: Sprint: a slug helper, with a standup

A targeted scenario for [#1746](https://github.com/HJeon139/postbox/issues/1746), a room that went idle while work was waiting, with all four agents on Claude Code: @alpha is the scrum master, @developer builds, @critic reviews and @researcher tests. It tests no fix: it’s there to reach the stall on purpose, so a fix can be measured against it. Run it before [its four-backend twin](standup-compat.md).

The owner saw #1746’s stall when the coordinator ran a standup, so this scenario puts one in the middle of the work, the way a burndown room runs: a board with an owner on every item, a definition of done, two increments, and a standup once the first is reviewed. A standup is all words. Every agent reports and ends its turn (in #1746’s words, “every agent had posted that it was ready and ended its turn”), and then somebody has to start the next item, which the board says is theirs. Nothing in the request says who speaks last, or tells anyone to stop.

Why a standup in particular can end a room, from `server/reply-back.mjs` on `main`:
- A status that names no one goes back to the coordinator, since its ping woke the turn. So do the others’, and the coordinator’s turn that takes them is woken only by replies that came back.
- If that turn only writes (“thanks, no blockers, carry on”) and names no one, its line goes back once to each agent it answered. An agent that acknowledges it in words is delivered once more; the coordinator’s next line to that agent, if it only writes again, is its second in a row and wakes no one (#1591). An agent that reacts to the line ends the exchange there (#1553).
- So after one round of closing lines every exchange has ended, by rules made to stop acknowledgment loops. The sprint goes on only if some turn in the round did work or named the next owner. If each agent waits to be told and the coordinator assigns nothing by name, the room is quiet with increment 2 on the board.
- With the change in review in #1759 (a reaction to a direct mention ends the exchange too, unless the turn did work), an agent that reacts to the standup ping and writes its status wakes no one: the coordinator never hears the round. That is the case to expect a stall from first.

What decides the run is read from its records:
- `idle-work-waiting` fails the run for #1746 when the room had no agent in a turn and no new item for 5 minutes or more with the nightly check not passed, nobody needing you and no wake scheduled. Here that is a room that stopped before anyone queued the check, which the finding says.
- `after-standup` is a measurement: for the first quiet minute after the standup, what was waiting and what moved the room, and each agent’s last turn before it: what woke it (a mention, a reply that came back, a scheduled wake), whether it did work or only wrote, whether it reacted to what woke it, and whom its reply reached. An agent whose last reply “reached no agent” after a reaction or a second write-only reply was stopped by the rules; a room where every reply was delivered and nobody was named stopped for want of an assignment.
- `quiet-stretches` lists every quiet stretch of a minute or more, as in [idleroom](idleroom.md).

A run where nobody held a standup is a coverage gap, not a pass. A run where the sprint went on is a pass, and the nightly check needn’t have finished: it takes 12 minutes, and you’re back in 10.

`node tools/uat-run.mjs --scenario standup --max-turns 100 --max-minutes 30 --budget 2 --max-cost 8 --file no`. About 16 minutes, 10 of them waiting, and under $1: the first idleroom run, with the same four agents, cost $0.37 and took 54 agent turns.

## Phase 1: One request, then walk away

- triggers: work-handed-between-agents, standup-round-held
- steps: 8

Send this, exactly: “@alpha you’re the scrum master for a small sprint with developer, critic and researcher. Goal: slug.mjs exports slug(title), which makes a lowercase URL slug with hyphens. Two increments. Increment 1: slug.mjs and slug.test.mjs with five tests that pass under node --test; developer builds it and critic reviews it. Increment 2: an empty title gives ‘untitled’, with a test for it; developer builds it, critic reviews it, and researcher tries the helper by hand. It’s done when both increments are reviewed and committed and ‘node nightly.mjs status’ says the nightly check passed on that commit (‘node nightly.mjs queue’ starts it, and researcher owns that). Keep a board in BOARD.md with an owner on every item. When increment 1 is reviewed, hold a standup before anything else: ask every agent what it finished, what it does next and what blocks it, and have each answer you. Then the sprint goes on. Hand each step to the next agent yourselves. I’m stepping away: don’t wait on me, and tell me when it’s done.”

Then send nothing more in this phase. Each step, use the wait action and watch. Don’t relay anything between agents, don’t answer a question an agent could have asked another agent, and don’t tell anyone to carry on: if the room stops, that is what this run is here to record. Answer a permission card, or a block that asks something only you can decide, before you leave, and file each one as a finding, since the room waited on you for it.

Pass if @alpha handed increment 1 on without you, and then held a standup in which every other agent answered. Say who did what, in order; quote @alpha’s standup message and its last message after the answers; and say whether that last message named who does what next.

## Phase 2: Stay away, then come back

- triggers: room-quiet-while-work-waited
- steps: 6

You’re away. Send nothing. Use the wait action to wait 300 seconds, twice, one after the other.

After the second wait, before you send anything, say what the page shows: whether any agent is working, what BOARD.md’s items read as in the conversation (which are done, which aren’t, and whose they are), and whether anything on the page says the room has stopped with work left to do. Then send this, exactly: “I’m back. Is it done?” and wait for the answer.

Pass if the sprint went on after the standup with no message from you: increment 2 was built and reviewed, or the nightly check was queued and somebody is set to check it. Fail the phase if nothing moved after the standup’s last message while the board had unfinished items, and say whose the next item was and what that agent had last said. Say what moved the room again: your message, a wake an agent scheduled, or something Postbox did.
