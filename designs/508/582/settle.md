# #582 Part 3: one settle path for reads that can't reach Postbox

**Owner:** @gpt. **Status:** draft for review. **Base:** `origin/main` at `fd60393e`. Line numbers below are `main`'s and are cited for review only; the design names functions.

## 1. Scope

Every read that cannot be answered live is answered by one function, `settleOffline`. This part owns:
- `settleOffline(b, t)` and the claim that makes it run at most once per call;
- `settled(t)`, the only test of whether a call is taken;
- the journal order for a read (`call` before `reply`) and the reply record shape;
- the admission path for a fresh read (`take`, `queueTool`, `queueFull`), and deleting the two inline offline paths.

Not in this part: the timer and its arrival time (Part 1), and the transport close reasons and driver-loss hook (Part 2). Part 1 and Part 2 call `settleOffline`; neither reads `t.replied` or `t.replying` directly.

## 2. Contract

```
settled(t): boolean            // t.replied || !!t.replying
settleOffline(b, t): Promise<void>
```

- `settleOffline` is safe to call any number of times. The first call claims the call; later calls return at once.
- It never throws to its caller. Every failure becomes a result (`ok: false`) or a log line.
- It answers every shim of the turn through `toShims`, so a caller's connection need not still be open.

## 3. What `main` does (the code this replaces)

- `take(b, k, t)` (`broker-tools.mjs:114`) registers `t` in `b.tools` only when `queueFull` admits it.
- `queueTool` (`:147`) awaits `t.saved` (the `call` record), then sends the `tool` frame. A failed `call` record deletes `t` and returns the error to the shim (`:150–158`).
- `call()` has two inline offline paths: a resent read while detached (`known` branch, reads from the snapshot, writes `reply` without awaiting, sets `replied`) and a fresh read while detached (returns the snapshot, writes nothing). Both bypass `t.saved`, the mutex and `toShims`. **Both are deleted.**
- `onReply` (`:222`) waits on `t.replying` and then checks `t.replied` (`:224`, `:226`). Under this design it drops a late reply at once instead of waiting.
- The hello resend (`broker-postbox.mjs:55`) sends each call with `!t.replied`. A call being settled has `t.replying` set and `t.replied` still false, so it is resent. **This is the takeover race.** It becomes `!settled(t)`.
- `written` (`broker-records.mjs:40`) resolves to `''` or the error message and never rejects. `record` (`:20`) stamps `at`.
- `readLocal(…, true)` appends `OFFLINE_NOTE` (`broker-tools.mjs:122`, `:128`).
- `toShims(b, turn, type, body)` (`broker-state.mjs:117`) sends `body` to every shim of the turn. It needs no catch of its own: each shim's `send` already wraps its write in a `try`/`catch` and logs the failure (`broker-shim.mjs:27–32`), so a failed send never reaches the loop. T25 guards that catch.
- The `result` helper in `call()` truncates to `REMOTE_LIMITS.replyChars`. Replay restores `t.result` only when `r.text.length <= REMOTE_LIMITS.replyChars` (`broker-replay.mjs:56`). A longer answer must be cut the same way in the record and on the wire, or replay drops it.

## 4. The settle path

`settleOffline(b, t)`, in this order:
1. **Claim.** If `settled(t)`, return. Otherwise set `t.replying` to a promise. This is the first statement, before any `await`, so no other caller can pass the check.
2. **Clear the timer.** If `t.timer` is set, clear it and set it to `undefined` (Part 1 set it).
3. **Journal the call first.** `await t.saved`. If it resolves to an error string, return: `queueTool` has already removed the call and answered the shim.
4. **Read the snapshot.** `const res = await readLocal(b, t.turn, t.name, t.args, true)`. A read that throws is caught and becomes `{ ok: false, text }`. `readLocal` appends `OFFLINE_NOTE` at the end (`broker-tools.mjs:132`), so the cut must keep it. Cut the body first, then append the notice: `const text = offlineText(res.text)`, where `offlineText(s)` is `s.length <= replyChars ? s : s.slice(0, replyChars - OFFLINE_NOTE.length) + OFFLINE_NOTE`, with the body taken from before the notice was appended. The record, the cached result and the broadcast all use `text`, so replay restores what the shim got, and the notice is always there.
5. **Mark and record.** Set `t.result = { ok: res.ok, text }` and `t.replied = true`. Then `const err = await written(b, t.turn, 'tools', { op: 'reply', id: t.id, ok: res.ok, text })`; if `err`, log it with `b.log`. The reply record uses `text`, which is the field replay reads (`broker-replay.mjs:53–56`).
6. **Answer.** `toShims(b, t.turn, 'result', { id: t.id, ok: res.ok, text })`. A shim whose write fails is logged by that shim (`broker-shim.mjs:27–32`), and the other shims still get the answer. `settleOffline` itself never throws; a failure at any step becomes a log line and, where the call is still open, a result.
7. **Release.** Clear `t.replying` in a `finally`. Step 3's early return also goes through that `finally`. `queueTool` removes a call whose `call` record failed, so nothing else can claim it.

Step 5 sets `replied` before the journal write, so a failed write still delivers the answer (the fail-open rule). A failed write leaves the journal one `reply` short; restart replay then sees the call unsettled and resends it, which is the accepted trade-off. The loss is stated, not hidden.

## 5. Live replies and the claim

`onReply` for a call: if `settled(t)`, reply `no-tool` to Postbox and return, without waiting. Otherwise it claims the call the same way (sets `t.replying` before any `await`) and journals and answers as today. Whichever path claims first answers; the other sees `settled(t)` and returns. There is no path that waits and then answers.

**The timer on the live path.** `onReply` clears `t.timer` only after `t.replied = true`, which is after its journal write succeeds (Part 1 relies on this). So if the live write fails, the deadline stays armed and still bounds the call.

**A failed live journal write.** `main` leaves the call waiting when a live `written` fails, so Postbox can reply again. Under this design the live path releases its claim on failure, and then:
- if the link is down (`!b.attached()`), it calls `settleOffline(b, t)`, which answers from the snapshot. This covers `driverLost` having run during the write: its `settleOffline` saw `settled(t)` and returned, so the failure path must settle the call itself;
- if the link is up, it calls `armReadTimer(b, t)` (Part 1). The deadline may already have fired during the write; its callback clears `t.timer` and its `settleOffline` returned on `settled(t)`. Re-arming then computes `remaining = 0` and settles at once. Without this step the call would stay open with no timer and no trigger.

## 6. Admission and the detached read

- `take` takes `isDetachedRead = !b.attached() && t.route === 'read'`. A detached read is exempt from the waiting-call and waiting-byte limits, because it never waits for Postbox. It keeps the record-size check: a full record refuses the read with the existing message, a stated limit, not a journal failure.
- The `call` record written in `queueTool` carries `at: t.arrived` (the arrival time stamped at the top of `call()`, on the host clock). `record()` keeps an `at` it is given (`broker-records.mjs:22`), so replay can anchor the deadline on the admission-inclusive arrival time instead of the later write time. This is the one change in `queueTool`'s record for Part 1's replay.
- A fresh read, attached or not, goes `take` → `t.saved` → `queueTool` continues. In `queueTool`, after `await t.saved`: if `settled(t)` return; if `route === 'read' && !b.attached()`, `return settleOffline(b, t)`; otherwise the timer is armed (Part 1) and the `tool` frame is sent.
- A resent call that is still known: if `settled(t)`, return the kept answer (`answerKnown`); if detached, `settleOffline`; otherwise return and let the first answer arrive.

The order `call` before `reply` holds because the only path to `settleOffline` for a fresh call passes `await t.saved`, and the only path for a resent call passes the `known` check after its `saved`.

## 7. Hello resend

`for (const t of b.tools.values()) if (!settled(t)) send('tool', toolBody(t))`. A call claimed by `settleOffline` is never sent to the new driver. Part 1 arms timers at the same point, after this check.

## 8. Interfaces the other parts use

- **Part 1:** the timer callback calls `settleOffline(b, t).catch(…)`. Part 1 sets `t.timer` and `t.arrived`; Part 3 only clears `t.timer`.
- **Part 2:** `driverLost(b)` calls `settleOffline(b, t)` for each `t` with `t.route === 'read' && !settled(t)`, synchronously in the close path. Part 2 needs nothing else from this part.

## 9. Specs

- **T06** broadcast reaches every turn shim, including one that connected after the call.
- **T07** a live reply that arrives during `readLocal` is dropped; the shim gets one result.
- **T08** a live reply that arrives during the `written` await is dropped; one result.
- **T09** a failed `written` still answers the shim; the error is logged, not thrown.
- **T15** `call` precedes `reply` in `tools.jsonl` for a fresh detached read.
- **T17** a link loss during `t.saved` sends no `tool` frame and arms no timer.
- **T18** a fresh detached read registers `t`, writes `call` then `reply`, answers once, and a resend returns the kept answer.
- **T19** a detached read at the waiting-call limit is admitted and answered from the snapshot.
- **T20** a detached read on a full record is refused with the record-full message.
- **T21 (new)** a takeover hello that arrives during `readLocal` does not resend the call; the shim gets one result, the offline one.
- **T22 (new)** a late live reply after the claim gets `no-tool` without waiting.
- **T23 (new)** an offline read longer than `replyChars` has length at most `replyChars`, ends with `OFFLINE_NOTE`, and is the same text in the journal record and on the wire; replay restores it.
- **T24 (new)** a live `written` that fails while the link is down (driver lost during the write) settles the read offline. A live `written` that fails with the link up and the deadline already fired during the write settles at once, through the re-arm; a failure with the link up and the deadline still pending leaves the read open until it fires.
- **T25 (new)** a `send` that throws on one shim does not stop the answer reaching the other shims.

## 10. Open for review

- Settled: `t.replying` is released after `toShims`, as drafted. `t.replied` is already true by then, so `settled(t)` stays true and nothing depends on the release.
- Whether a resent call's `answerKnown` should also cover `settled(t)` with no result yet (a call still in `readLocal`). This draft returns and lets the first answer arrive, so no second answer is sent.

## 11. Known wire duplicate (accepted)

When a live reply wins and the same call is then resent from a connection that is still registered on the turn, that connection receives the kept result twice with the same text: once from the broadcast (`toShims`), once as the reply to its resend (`answerKnown`). The invariant is one answer per call, not one wire line per connection. The shim settles on the first result for an id and drops the second (`shim-link.mjs:82–83`), so the agent sees one answer. The spec for this is the race sweep's shape: every result a shim gets for the call has the same text. Suppressing the second line in the broker would need the broker to track which connection has heard which call, more state for no visible difference.

## 12. Test seam

The broker takes an `io` option (`appendFile`, `readFile`, `stat`), defaulting to `fs/promises`, as the Store does (`store.mjs`). It covers three calls: the journal append in `record()`, the snapshot read in `snapshotOf`, and the journal size check in `queueFull`. The other file calls in the broker are not covered. T07 and T08 hold the snapshot read and the reply's journal append with it, and T09 fails the reply's append. Each has a mutation control: the claim moved past `readLocal` (T07), the live claim removed during its write (T08), and a throw after the failed-write log (T09, which then times out waiting for the shim).
