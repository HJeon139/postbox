# Host wakes: a hand-off between machines while a wake card waits

- persona: An engineer who runs agents on a lab machine and a laptop, hands work between them, and leaves cards for later when busy. Writes short messages.
- agents: researcher, critic, developer
- place: critic=host1, researcher=local, developer=local
- project: Hand-offs
- conversation: Across machines

A run with one host (`--host`, once), Claude Code only: @critic runs there, and @researcher and @developer on this computer. Postbox stops two agents waking each other after a hand-off and its answer: their third wake in a row raises a card for the person (`PAIR_LIMIT`, `shared/limits.mjs`). While one such card waits, a wake that needs a second card is refused (`askToWake`, `server/side-threads.mjs`). This run makes that happen from a host and from this computer, and checks what each sender is told, when, and whether the work it handed off is lost. Watch for an agent that says it handed work on when it didn’t, an agent left idle with work it was never given, and a refusal that names no card.

Every message you send clears the counts of wakes in a row (`postUserMessage`, `server/message-queue.mjs`). So each wake that has to reach the limit is the third in a row between two agents since your last message: one message asks for the request, its answer and the next wake together, and you write nothing until it has happened. The checks also read which agents start a turn after a refused hand-off, so wake only the agents each step names.

## Phase 1: Open a wake card, and leave it

- triggers: pair-card-opened
- steps: 6

In one message, ask @researcher to send @developer one line by @-mention, asking it to review a three-line shell function and to answer by @-mentioning @researcher. When @developer answers, @researcher sends it a short follow-up by @-mention, saying no reply is needed. That follow-up is their third wake in a row, and it raises a card (“Let @researcher wake @developer?”). Wait until the card shows, and don’t answer it.

## Phase 2: Hand-offs while the card waits

- triggers: local-wake-told-in-turn, refused-wake-told-in-turn
- steps: 12

With the card still open, in one message, ask @critic (host1) to send @researcher one line by @-mention saying it has a task, and asking it to answer by @-mentioning only @critic. When @researcher answers, @critic hands it the task with wake_agent: “count the lines in work/*.txt and post the total”. That is their third wake in a row, so it needs a second card, and Postbox refuses it. Then don’t write anything for 3 minutes (wait 180 seconds), so nothing but the refusal can wake @critic. Then ask @critic what happened to its hand-off, and tell it not to send it again.

Then, in one message, ask @developer (this computer) to do the same with @critic: one line by @-mention, asking it to answer by @-mentioning only @developer, then the task with wake_agent: “list the files in work/ and post their names”. Wait 180 seconds again, then ask @developer what happened to its hand-off, and tell it not to send it again. Don’t message @researcher or @critic after their refused hand-offs.

## Phase 3: Answer the card

- triggers: held-wake-delivered-after-allow
- steps: 6

Allow the card from phase 1. Then wait 2 minutes without writing, and read the conversation: check whether the two refused hand-offs reach @researcher and @critic, or whether each sender would have to send them again. Don’t message either of them to find out.

On `main`, expect phase 1’s trigger and `local-wake-told-in-turn` to be seen, and `refused-wake-told-in-turn` and `held-wake-delivered-after-allow` not: a host sender hears of its refusal only at its next turn, and a refused wake is dropped (#439). The checks `host-wake-said-sent` and `refused-wake-lost` report those two defects as findings.
