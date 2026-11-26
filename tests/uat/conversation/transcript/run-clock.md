# Run clock lines

**Where:** In the conversation, as a system line, at each change of an agent’s run clock. Only a Postbox started with `POSTBOX_RUN_CLOCK=1`, as the UAT runner starts it, has run clocks. The person starts, pauses, resumes and stops a clock with `POST /api/sessions/:id/clock`; it has no control in the page yet.

## Why it exists

A run clock holds its agent: while it’s paused, and for good once it expires, Postbox starts no turn of that agent, and what the agent is sent waits in its inbox (designs/architecture/run-clock.md). Without a line, an agent with an expired clock looks as if it simply never answers. The line says what happened and what the person can do (#1526).

## Expected functionality

- **Started:** “@timed’s run clock started, with a budget of 60s.”
- **Paused:** with @timed idle, “@timed’s run clock is paused. Postbox starts no turn of @timed until the clock resumes.” During a turn: “@timed’s run clock is paused. Postbox stopped @timed, and starts no turn of it until the clock resumes. Until its stopped turn has ended, @timed may still be working, so the clock counts on.”
- **Resumed:** “@timed’s run clock resumed at 10s of 60s.”, with the time used so far, which leaves out the pause.
- **Expired:** with @timed idle, “@timed’s run clock reached its budget of 60s. Messages to @timed here now wait, and no turn starts; a new timed run goes in a new conversation.” During a turn, the first sentence ends “so Postbox stopped @timed’s turn, which may run on until its CLI has exited.”
- **Ended:** when the person stops the run early (#1749), with @timed idle: “@timed’s run clock ended at 12s of 60s, because you stopped it. Messages to @timed here now wait, and no turn starts; a new timed run goes in a new conversation.” During a turn, the first sentence ends “so Postbox stopped @timed’s turn, which may run on until its CLI has exited.” A resume afterward is refused.
- **Restored:** when Postbox starts again with the clock running: “Postbox started again with @timed’s run clock at 30s of 60s. The time it was down counted.” For an agent on a host, it goes on “, and @timed may have worked through it on its host.”
- A restart never repeats a line: an expired, ended or paused clock shows its line once, even when its stopped turn’s end came after it.
- Each is a plain line, like the other system lines, and starts no turn. It fits a 375 px window.
- **A reply the clock stopped** is tagged “Stopped at 14:06: its run clock reached its budget”, or “… its run clock was paused”, never “Stopped by you”: the person didn’t press Stop. A reply the person’s stop of the clock stopped (#1749) reads “Stopped by you”, since they did.

## Steps to reproduce

1. Start Postbox with `POSTBOX_RUN_CLOCK=1` and a `--data` folder of your own, open a conversation with one agent, and copy its session id from the state (`/api/state`).
2. From the page’s console, `fetch('/api/sessions/<id>/clock', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'start', budgetS: 60 }) })`.
3. Pause and resume it the same way (`{ action: 'pause' }`, `{ action: 'resume' }`), then wait for the budget to run out.
4. Send the agent a message.
5. In a new conversation, start a clock, ask the agent for a long task, and stop the clock mid-turn (`{ action: 'stop' }`). Then try `{ action: 'resume' }`.

**Passes when:** each change shows its line, the agent stops at the pause, at the budget and at the stop, the message after the budget starts no turn, and the resume after the stop is refused with a 409.

## Related

- `tests/browser/run-clock.spec.mjs`, `tests/run-clock.test.mjs`, `tests/run-clock-stop.test.mjs`
- designs/architecture/run-clock.md
