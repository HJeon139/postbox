# Host wakes: a hand-off between machines while a wake card waits

- persona: An engineer who runs agents on a lab machine and a laptop, hands work between them, and leaves cards for later when busy. Writes short messages.
- agents: researcher, critic, developer
- place: critic=host1, researcher=local, developer=local
- project: Hand-offs
- conversation: Across machines

**Needs rework since #492:** there is no pair limit now, so phase 1’s third wake in a row no longer raises a card, and phase 2’s hand-offs go rather than wait on it. A card now comes only from the chain limit (`HOP_LIMIT`). Until the phases are rebuilt on that, a run of this scenario won’t reach its triggers.

A run with one host (`--host`, once), Claude Code only: @critic runs there, and @researcher and @developer on this computer. Phase 1’s card is researcher’s wake of developer; phase 2’s two hand-offs are between critic and researcher, one each way, so developer, the card’s target, takes no part until phase 3 allows the card. Postbox stops two agents waking each other after a hand-off and its answer: their third wake in a row raises a card for the person (`PAIR_LIMIT`, `shared/limits.mjs`). While one such card waits, a wake that needs a second card is held on it until the person answers (`askToWake`, `server/wake-cards.mjs`, #439); before #439’s fix it was refused. This run makes that happen from a host and from this computer, and checks what each sender is told, when, and whether the work it handed off is lost. Watch for an agent that says it handed work on when it didn’t, an agent left idle with work it was never given, and a refusal that names no card.

Every message you send clears the counts of wakes in a row (`postUserMessage`, `server/message-queue.mjs`). So each wake that has to reach the limit is the third in a row between two agents since your last message: one message asks for the request, its answer and the next wake together, and you write nothing until it has happened. The checks also read which agents start a turn after a refused hand-off, so wake only the agents each step names: in each message, @-mention only the agent it’s for, and name the others without @, since an @-mention anywhere in your message wakes that agent. That includes telling an agent whom to @-mention: write “a reply that @-mentions researcher”, not “@researcher”.

## Phase 1: Open a wake card, and leave it

- triggers: pair-card-opened
- steps: 8

In one message that @-mentions only @researcher, ask it to send developer this shell function to review, word for word, in a reply that @-mentions developer, not with wake_agent: `count_lines() { wc -l < "$1"; }`. Ask researcher to tell developer, in that same reply, to answer once by @-mentioning researcher and not to ask anything else. When developer answers, researcher sends a one-line thank-you by @-mention that says no reply is needed. That thank-you is their third wake in a row, and it raises a card (“Let @researcher wake @developer?”). Wait until the card shows, and don’t answer it.

Then, in one message that @-mentions only @researcher, ask it to stop messaging developer: it answers you in one line without @-mentioning anyone, and doesn’t message developer again in this conversation. Requests from you or from critic later still get an answer. Wait until it has answered and no agent is working. Your message clears the counts and leaves the card open, which is what phase 2 needs.

From here to phase 3’s Allow, don’t write to developer, and no step wakes it: developer is the card’s target, and on a build with #439’s fix, writing to a card’s target, or another agent waking it, retires the card (it got a turn another way), so there would be nothing left to allow.

## Phase 2: Hand-offs while the card waits

- triggers: wake-held-on-card
- steps: 12

The card stays open and no agent works during this phase’s waits, so you’ll be told the card still waits on you: leave it, and ask for the same wait again; the second time it goes ahead.

With the card still open, in one message that @-mentions only @critic (host1), ask it to tell researcher it has a task, in a reply that @-mentions researcher, and to ask researcher to answer once by @-mentioning critic. When researcher answers, critic hands it the task with the wake_agent tool, without @-mentioning anyone in its reply: “count the lines in work/*.txt and post the total”. That hand-off is their third wake in a row, so it needs a second card, and Postbox holds it on the open one. Then, before you ask anything, don’t write for 3 minutes: use a wait of 180 seconds, so nothing but Postbox’s answer can wake @critic. Only then ask @critic what happened to its hand-off, and tell it not to send that hand-off again; it still answers researcher’s next request.

Then, in one message that @-mentions only @researcher (this computer), ask it to do the same with critic: one line that @-mentions critic, asking it to answer once by @-mentioning researcher, then the task with wake_agent, without @-mentioning anyone: “list the files in work/ and post their names”. That’s their third wake in a row since your message, so it needs a card too. Use a wait of 180 seconds again before you ask anything, then ask @researcher what happened to its hand-off, and tell it not to send it again or @-mention anyone. Don’t message critic after its hand-off from researcher.

## Phase 3: Answer the card

- triggers: held-wake-delivered-after-allow
- steps: 6

Allow the card from phase 1. Then wait 120 seconds without writing (a wait of 120 seconds). If you’re told something still waits on you, such as a new card, leave it and ask for the same wait again: the second time it goes ahead. Then read the conversation, and check whether the two held hand-offs reach researcher and critic, or whether each sender would have to send them again. Don’t message either of them to find out.

Phase 2’s trigger is the fixed build’s: `wake-held-on-card`, where `wake_agent` answers “Postbox is holding your message…”, on a host too. Expect it, phase 1’s and phase 3’s triggers, and no finding from `host-wake-said-sent` or `refused-wake-lost`: a held hand-off is judged lost only if it never arrives once its card is answered.

A build before #439’s fix (before v0.42.1) refuses the hand-offs instead. Phase 2 then ends at its step cap with a gap, `local-wake-told-in-turn` and `refused-wake-told-in-turn` show what each sender was told, and the two checks report the defects: a host sender told its wake was sent, and a refused hand-off lost.
