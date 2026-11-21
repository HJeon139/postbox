# Run clock lines

**Where:** In the conversation, as a system line, at each change of an agent’s run clock. Only a Postbox started with `POSTBOX_RUN_CLOCK=1`, as the UAT runner starts it, has run clocks. The person starts, pauses and resumes a clock with `POST /api/sessions/:id/clock`; it has no control in the page yet.

## Why it exists

A run clock holds its agent: while it’s paused, and for good once it expires, Postbox starts no turn of that agent, and what the agent is sent waits in its inbox (designs/architecture/run-clock.md). Without a line, an agent with an expired clock looks as if it simply never answers. The line says what happened and what the person can do (#1526).

## Expected functionality

- **Started:** “@timed’s run clock started, with a budget of 60s.”
- **Paused:** “@timed’s run clock is paused. Postbox stopped @timed, and starts no turn of it until the clock resumes.”
- **Resumed:** “@timed’s run clock resumed at 10s of 60s.”, with the time used so far, which leaves out the pause.
- **Expired:** “@timed’s run clock reached its budget of 60s, so Postbox stopped @timed. Messages to @timed here now wait, and no turn starts; a new timed run goes in a new conversation.”
- **Restored:** when Postbox starts again with the clock running: “Postbox started again with @timed’s run clock at 30s of 60s. The time it was down counted, and @timed may have worked through it on its host.”
- Each is a plain line, like the other system lines, and starts no turn. It fits a 375 px window.
- **A reply the clock stopped** is tagged “Stopped at 14:06: its run clock reached its budget”, or “… its run clock was paused”, never “Stopped by you”: the person didn’t press Stop.

## Steps to reproduce

1. Start Postbox with `POSTBOX_RUN_CLOCK=1` and a `--data` folder of your own, open a conversation with one agent, and copy its session id from the state (`/api/state`).
2. From the page’s console, `fetch('/api/sessions/<id>/clock', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'start', budgetS: 60 }) })`.
3. Pause and resume it the same way (`{ action: 'pause' }`, `{ action: 'resume' }`), then wait for the budget to run out.
4. Send the agent a message.

**Passes when:** each change shows its line, the agent stops at the pause and at the budget, and the message after the budget starts no turn.

## Related

- `tests/browser/run-clock.spec.mjs`, `tests/run-clock.test.mjs`
- designs/architecture/run-clock.md
