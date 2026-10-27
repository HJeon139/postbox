# Host wakes: a hand-off between machines while a wake card waits

- persona: An engineer who runs agents on a lab machine and a laptop, hands work between them, and leaves cards for later when busy. Writes short messages.
- agents: researcher, critic, developer
- place: critic=host1, researcher=local, developer=local
- project: Hand-offs
- conversation: Across machines

A run with one host (`--host`, once), Claude Code only: @critic runs there, and @researcher and @developer on this computer. Postbox stops two agents waking each other after a hand-off and its answer: their third wake in a row raises a card for the person (`PAIR_LIMIT`, `shared/limits.mjs`). While one such card waits, a wake that needs a second card is refused (`askToWake`, `server/side-threads.mjs`). This run makes that happen from a host and from this computer, and checks what each sender is told, when, and whether the work it handed off is lost. Watch for an agent that says it handed work on when it didn’t, an agent left idle with work it was never given, and a refusal that names no card.

## Phase 1: Open a wake card, and leave it

- triggers: pair-card-opened
- steps: 8

Ask @researcher to send @critic one line asking for a review of a three-line shell function, by @-mentioning it, and @critic to answer @researcher by @-mentioning it back. Then ask @researcher to send @critic a follow-up, again by @-mention: their third wake in a row raises a card (“Let @researcher wake @critic?”). Don’t answer it. Ask @developer and @critic to swap two lines the same way, a request and its answer, so that pair is at its limit too.

## Phase 2: Hand-offs while the card waits

- triggers: local-wake-told-in-turn, refused-wake-told-in-turn
- steps: 10

With the card still open, ask @critic (host1) to hand @researcher a task with wake_agent: “count the lines in work/*.txt and post the total”. It needs a second card, so Postbox refuses it. Then ask @developer (this computer) to hand @critic a task the same way. Don’t write anything else for 3 minutes (wait 180 seconds), so nothing but the refusal can wake either sender. Then ask each sender what happened to its hand-off.

## Phase 3: Answer the card

- triggers: held-wake-delivered-after-allow
- steps: 6

Allow the card from phase 1. Check whether the two refused hand-offs ever reach @researcher and @critic, or whether each sender has to send them again.

On `main`, expect phase 1’s trigger and `local-wake-told-in-turn` to be seen, and `refused-wake-told-in-turn` and `held-wake-delivered-after-allow` not: a host sender hears of its refusal only at its next turn, and a refused wake is dropped (#439). The checks `host-wake-said-sent` and `refused-wake-lost` report those two defects as findings.
