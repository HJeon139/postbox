# Idle room on four backends: a scrum team’s two sprints, and where the room stops

- persona: A product owner who is also the team’s customer. Hands a scrum team a product goal and a backlog, expects it to run its own sprints by the book, and comes back only for the demo, which they accept or send back. Sends each message as this scenario words it. While away they send nothing, relay nothing and prompt nobody; they answer only what’s theirs to decide: the demo, or a permission card.
- agents: alpha, developer, critic, researcher
- backends: critic=codex:gpt-6-luna, developer=antigravity-cli:gemini-3.8-flash-high, alpha=kiro-cli:qwen3-coder-next
- permission_modes: alpha=auto, developer=auto, critic=auto, researcher=auto
- files: sprint
- project: Slugs
- conversation: Sprint room: a slug module

The compatibility run (`--compat`) of [idleroom](idleroom.md), for [#1746](https://github.com/HJeon139/postbox/issues/1746): the same request and the same phases, word for word, with @alpha as the scrum master on the Kiro CLI, and a team of @developer on the Antigravity CLI, @critic on Codex and @researcher on Claude Code. Run the Claude-only one first. The reply rules are Postbox’s and the same on every backend; whether an agent reacts, names who is next or waits to be told is its harness’s and its model’s habit, which is what this run adds. It tests no fix.

The room is a scrum team, run the way Postbox’s own sprint rooms were (designs/rooms-at-scale.md, “Why”; #1605, #1606): @alpha is the scrum master and keeps the sprint board, and @developer, @critic and @researcher are the team. You are the product owner and the customer. The request gives a product goal and a backlog of six small stories on one module, more than a sprint holds, and names the ceremonies you expect: backlog grooming, estimation by the team, sprint planning, each agent taking its own story, a standup while work is in progress, a demo to you, a retrospective with action items, and a second sprint that takes them up. It doesn’t say what anyone should write. The scrum master runs the ceremonies; your only messages are the request, the demo’s answer and one question when you come back.

The board is a small tool in the project (`node board.mjs`, the `sprint` fixture) that writes `BOARD.md` and keeps its own timestamped record of every change. So each ceremony leaves something the run can read on any backend, and the event history says which agent ran each command:

| Ceremony           | Trigger                       | What the records must show                                                                                                                                             |
| ------------------ | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backlog grooming   | `backlog-groomed`             | three stories or more on the board, and one ordered, split or clarified before the first sprint                                                                        |
| Estimation         | `stories-estimated`           | estimates entered by two agents or more, not the scrum master alone                                                                                                    |
| Sprint planning    | `sprint-planned`              | sprint 1 planned with a goal and fewer stories than the backlog holds                                                                                                  |
| Task election      | `tasks-elected`               | three agents each took a story themselves                                                                                                                              |
| Standup            | `standup-round-held`          | one agent’s turn that every other agent answered, each answer reaching the one who asked, while a story someone had taken wasn’t done; the word “standup” isn’t needed |
| Demo               | `demo-shown`, `demo-answered` | the sprint’s stories listed for the customer with one or more done, then your answer                                                                                   |
| A story sent back  | `story-sent-back`             | the story you didn’t accept back in the backlog, or in a later sprint’s plan                                                                                           |
| Retrospective      | `retro-held`                  | action items on the board after the demo                                                                                                                               |
| The next iteration | `next-sprint-took-actions`    | sprint 2’s plan takes an action item and the story sent back                                                                                                           |

A ceremony the room skipped is a coverage gap for it, not a failure of the run and not a pass.

If the room stops between ceremonies, that is the finding, and it’s read from the records:
- `idle-work-waiting` fails the run for #1746 when no agent was in a turn and no item arrived for 5 minutes or more while the second sprint wasn’t finished, no agent needed you, no wake was scheduled, and the room wasn’t waiting for your answer to a demo.
- `after-ceremony` is a measurement: for each quiet minute, which ceremony came before it, which of the sprint’s stories weren’t done and whose they were, and each agent’s last turn: what woke it (a mention, a reply that came back, a scheduled wake), whether it did work or only wrote, whether it reacted to what woke it, and whom its reply reached. A standup is all words, and the reply rules end an exchange of turns that only write (`server/reply-back.mjs`): this is what shows whether that is where the room died, or whether nobody took the next story.
- `quiet-stretches` lists every quiet stretch of a minute or more, with what was waiting and what moved the room.
- A `stalled` finding of the runner’s (#1760) isn’t this: it says agents worked for five minutes without a pause.

A run that stops at `--max-turns` or `--max-minutes` says so in its report, and every ceremony it hadn’t reached is a coverage gap. The first run of this room’s earlier, one-pass form took 54 agent turns for a minute of work, most of them acknowledgments, so the turn bound is sized for that.

`node tools/uat-run.mjs --scenario idleroom-compat --compat --max-turns 300 --max-minutes 50 --turn-timeout 1800 --budget 3 --max-cost 9 --file no`. About 30 minutes, 10 of them away. The tester and @researcher cost about $1 between them; Codex, Kiro and Antigravity report no cost to the run, and spend their own credits.

## Phase 1: The request, and sprint 1 to its demo

- triggers: backlog-groomed, stories-estimated, sprint-planned, tasks-elected, standup-round-held, demo-shown
- steps: 12

Send this, exactly: “@alpha you’re the scrum master of a scrum team of three: developer, critic and researcher, who each build and who review and test one another’s work. I’m the product owner and your customer. Product goal: slug.mjs, a small module that turns a title into a URL slug, with tests that pass under node --test. The backlog, in no order: a title becomes lowercase words joined by hyphens; punctuation and repeated spaces never leave a leading, trailing or doubled hyphen; an empty title gives ‘untitled’; a slug is at most 40 characters, cut at a word; digits are kept; and ‘node slug.mjs "A Title"’ prints the slug. Run it as scrum, by the agile manifesto, on the sprint board in this folder (‘node board.mjs help’). I expect the ceremonies: groom the backlog; have the team estimate the stories; plan a sprint with a goal and only what the team can finish, about three stories, so there are two sprints at least; let each of the team take their own story; hold a standup while the work is in progress; and at the sprint’s end show me a demo of working software, which I’ll accept or send back. Then hold a retrospective with action items on the board, and plan the next sprint with them in it. Work it out between you, and don’t wait on me for anything but the demo.”

Then send nothing more until the demo reaches you. Each step, use the wait action to wait 60 seconds, and watch. Don’t relay anything between agents, don’t answer a question an agent could have asked another agent, and don’t tell anyone to carry on or what comes next: if the room stops between ceremonies, wait again, since that is what this run is here to record. Answer a permission card, and file it as a finding, since the room waited on you for it.

When the demo reaches you, don’t answer it in this phase: answer next_phase. If the run holds that for something that hasn’t happened, ask again; a ceremony the team skipped is a coverage gap, and not yours to cause.

Pass if the team reached the demo of sprint 1 without a message from you after the request. Say which ceremonies you saw, in order, and who ran each; for the standup, quote the scrum master’s message and its last message after the answers, and say whether that last message named who does what next. If the room went quiet before the demo, say after which ceremony, and what each agent had last said.

## Phase 2: The demo’s answer, then walk away

- triggers: demo-answered, story-sent-back, retro-held, next-sprint-took-actions
- steps: 8

If no demo reached you in phase 1, there’s none to answer: say so, send “I’m back. Where does sprint 1 stand?”, wait for the answer, and say what moved the room. That is this phase’s result.

Otherwise, answer the demo. If it came as a block, answer the block to the same effect first. Then send this, with the story named as the demo named it: “Demo: I accept the sprint, except the story about lowercase words joined by hyphens: it must also drop accents, so ‘Café au lait’ gives ‘cafe-au-lait’. Take it back into the next sprint.” If that story wasn’t in the sprint, name the first story the demo showed instead, with the same new rule.

Then you’re away. Send nothing. Use the wait action to wait 300 seconds, twice, one after the other.

After the second wait, before you send anything, say what the page shows: whether any agent is working, whether a retrospective and a second sprint’s plan are in the conversation, and whether anything on the page says the room has stopped with work left to do. Then send this, exactly: “I’m back. Where does sprint 2 stand?” and wait for the answer.

Pass if, with no message from you after the demo’s answer, the team put the story back, held a retrospective with action items, and planned a second sprint that takes them and the story. Fail the phase if the room went quiet before that, and say after which ceremony, whose the next step was and what that agent had last said. Say what moved the room again: your message, a wake an agent scheduled, or something Postbox did.
