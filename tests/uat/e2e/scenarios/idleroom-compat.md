# Idle room on four backends: a sprint that stops while work is waiting

- persona: A developer who gives a small team of agents one goal with a definition of done, then steps away for twenty minutes and expects to come back to finished work. Sends each message exactly as this scenario words it. While away they send nothing, relay nothing and prompt nobody; they answer only what’s theirs to decide, such as a permission card.
- agents: alpha, developer, critic, researcher
- backends: critic=codex:gpt-6-luna, developer=antigravity-cli:gemini-3.8-flash-high, alpha=kiro-cli:qwen3-coder-next
- permission_modes: alpha=auto, developer=auto, critic=auto, researcher=auto
- files: nightly
- project: Slugs
- conversation: Sprint: a slug helper

The compatibility run (`--compat`) of [idleroom](idleroom.md), for [#1746](https://github.com/HJeon139/postbox/issues/1746): the same request and the same phases, word for word, with @alpha coordinating on the Kiro CLI, @developer building on the Antigravity CLI, @critic reviewing on Codex and @researcher testing on Claude Code. Run the Claude-only one first: a stall on four backends that isn’t there on one, or the reverse, is a different finding, and a hand-off one harness drops is a gap in phase 1 that says nothing of #1746. It tests no fix.

The room works the way Postbox’s own sprint rooms did (designs/rooms-at-scale.md, “Why”; #1605, #1606): a coordinator who keeps the board and the definition of done, a builder, a reviewer and a tester, one request from the person, small steps handed from agent to agent, and working software as the measure. The definition of done ends in a timed step. `node nightly.mjs queue` (the `nightly` fixture) starts a check that takes 12 minutes and tells nobody when it has finished; `node nightly.mjs status` says how it went. Twelve minutes is #1746’s own wait, and longer than one shell command may run in a turn (Claude Code’s limit is 10), so an agent can’t simply sit on it. Once the check is queued, every agent can truthfully say its part is ready and end its turn, and the next step waits on a clock that sends no message: the shape of #1746’s first stretch. Nothing in the request says how to wait. An agent that schedules its own wake, or checks again by itself, is doing it right.

What decides the run is read from its records, not from what the tester saw:
- `idle-work-waiting` fails the run for #1746 when the room had no agent in a turn and no new item for 5 minutes or more after the nightly check was due, while it hadn’t passed, no agent needed you and no wake was scheduled. A room that stopped before anyone queued the check gets the same finding, which says so.
- `quiet-stretches` lists every quiet stretch of a minute or more: how long, what was waiting (the person, a scheduled wake, nothing, or nothing because the work was done), how much of it came after the check was due, and what moved the room again; and how long after the check was due the room first knew it had passed. Compare a run on `main` and a run on a fix by pass or fail, by what moved the room and by that last number, not by a failing run’s length, which your own waits set.
- `ask-uncounted-mid-turn` fails the run when an ask shown while its turn ran went 30 seconds or more without counting as “needs you”.

On `main` today the run is expected to fail: phase 2 ends with the room quiet for about 20 minutes, 8 of them after the check was due, moved only by your message, and phase 3 with a form that counts only when its turn ends. A run where an agent kept a turn open through the wait, such as with two long commands one after the other, never reaches the stall, and says so as a coverage gap, not as a pass.

`node tools/uat-run.mjs --scenario idleroom-compat --compat --max-turns 60 --max-minutes 55 --budget 2 --max-cost 8 --file no`. About 35 minutes, 22 of them waiting. The tester and @researcher cost about $1 between them; Codex, Kiro and Antigravity report no cost to the run, and spend their own credits on some 25 short turns.

## Phase 1: One request, then walk away

- triggers: work-handed-between-agents, timed-step-queued
- steps: 8

Send this, exactly: “@alpha you’re coordinating a small sprint with developer, critic and researcher. Goal: slug.mjs exports slug(title), which makes a lowercase URL slug with hyphens. It’s done when all of this is true: slug.test.mjs has five tests that pass under node --test; critic has reviewed the code and developer has fixed what it found; the work is committed; and ‘node nightly.mjs status’ says the nightly check passed on that commit (‘node nightly.mjs queue’ starts it). Keep a board in BOARD.md. Developer builds, critic reviews, researcher tries the helper by hand and confirms the nightly result. Work in small steps and hand each one to the next agent yourselves. I’m stepping away: don’t wait on me, and tell me when it’s done.”

Then send nothing more in this phase. Each step, use the wait action and watch. Don’t relay anything between agents, don’t answer a question an agent could have asked another agent, and don’t tell anyone to carry on: if the room stops, that is what this run is here to record. Answer a permission card, or a block that asks something only you can decide, before you leave, and file each one as a finding, since the room waited on you for it.

Pass if @alpha handed the work on without you, at least three agents took part, and one of them queued the nightly check. Say who did what, in order, and what each agent’s last message was before the room went quiet.

## Phase 2: Stay away, then come back

- triggers: room-quiet-while-work-waited
- steps: 8

You’re away. Send nothing. Use the wait action to wait 300 seconds, four times, one after another: the nightly check finishes during the third wait, and nothing tells the room.

After the fourth wait, before you send anything, say what the page shows: whether any agent is working, whether the nightly check’s result is in the conversation, and whether anything on the page (the top bar, the Agents section, a notice) says the room has stopped with work left to do. Then send this, exactly: “I’m back. Is it done?” and wait for the answer.

Pass if, when you came back, an agent had already checked the nightly result and @alpha had told you it’s done, with no message from you. Fail the phase if the room was idle with the check unconfirmed, and say which agent was to take the next step and what it had last said. Say what moved the room again: your message, a wake an agent scheduled, or something Postbox did.

## Phase 3: An ask shown while its agent still works

- triggers: ask-shown-mid-turn
- steps: 6

Send this, exactly: “@researcher two things in one turn. First show me a form with one text field that asks what to call the release notes file. Then, without waiting for my answer, run ‘node -e "setTimeout(() => {}, 100000)"’ in the shell, which takes 100 seconds, and after it tell me what ‘node nightly.mjs status’ prints.”

The run hands you the form while @researcher still works. Don’t answer it yet. Say what the top bar and the Agents section say needs you at that moment. Then wait 60 seconds and say it again. Answer the form with “RELEASES.md” only once @researcher’s turn has ended; if you answered sooner, say so.

Pass if the page counted the form as needing you while @researcher’s turn still ran. Fail the phase if it said nothing needs you beside the open form.

Don’t try to move on while that turn runs. The runner holds a `next_phase` given while an ask waits, and then gives you no step until the turn ends, since it hands each ask back once (#1746’s second stretch, in `tools/uat/turns.mjs`). Here that costs at most the 100 seconds the command takes.
