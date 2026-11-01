# #582 Part 1: remote read deadline and replay clamping

**Document File:** `designs/508/582/deadline.md`  
**Owner:** @gemini. **Status:** draft for review. **Base:** `origin/main` at `fd60393e`.  
**Interface Dependencies:** `designs/508/582/settle.md` (`settled(t)`, `settleOffline(b, t)` from @gpt), `designs/508/582/link.md` (`close(reason)`, `driverLost(b)` from @engineer).

---

## 1. Scope

This part establishes the 100-second execution deadline for remote reads in the host broker and manages the timer lifecycle. It owns:
- `REMOTE_READ_TIMEOUT_MS = 100000;` in `shared/limits.mjs`;
- `armReadTimer(b, t)`, the remaining-time calculation, and two-sided clock-jump clamping;
- the arrival timestamp `t.arrived` captured at the earliest entry point in `call()`;
- restoring `arrived` from the journal's `r.at` in `loadTurn` with integer validation;
- checking expiry before sending in hello resend in `broker-postbox.mjs` and re-arming unexpired reads;
- clearing `t.timer` only after `t.replied = true` on live reply and on broker close;
- the deadline and replay test specifications (T02, T10, T11, T13, T14).

Not in this part: the settle engine (`settleOffline`, mutex claim, snapshot read, reply record, and broadcast), which belongs to `settle.md` (Part 3); and the socket termination contract and driver-loss trigger, which belongs to `link.md` (Part 2).

---

## 2. Contract & External Interfaces

```typescript
armReadTimer(b: Broker, t: Tool): void
```

- **Consumed from `settle.md` (Part 3):**
  - `settled(t): boolean` — returns `t.replied || !!t.replying`. If `settled(t)` is true, the timer does not arm and does not fire.
  - `settleOffline(b, t): Promise<void>` — invoked when the timer expires or when remaining time is 0. All calls use `.catch(b.log)`.
  - In `server/remote/host/broker-tools.mjs`, `armReadTimer`, `settled`, `settleOffline`, `queueTool`, `call`, and `onReply` live as siblings in the same file, avoiding circular module dependencies.
- **Merge Order:** Part 3 lands first without timers. Part 1 rebases on Part 3 and adds `armReadTimer` at the two designated call sites (`queueTool` and `onHello`).

---

## 3. Arrival Inception & Host Clock Semantics

### 3.1 Arrival Timestamping at the Earliest Boundary
Kiro's client-side 120-second per-call timer (`requestTimeout: 120000` under `McpServers field` in `kiro.dev/docs/custom-agents/configuration-reference`; assumed: client-side per-call timeouts typically start upon invocation dispatch by the agent CLI) starts when the agent CLI emits the call. In `server/remote/host/broker-tools.mjs`, `call()` awaits `refusal()` and `prepare()` before constructing `t`.

To guarantee that the 100-second deadline strictly bounds elapsed time across all pre-admission waits:
1. `call(b, c, turn, m)` captures `const arrived = b.now();` as its very first statement.
2. When admitted and constructed, `t` stores `arrived`.
3. Part 3 (`settle.md`, signed at `18e63ee0`) owns the `queueTool` implementation and stamps `at: t.arrived` onto the `call` record. Part 1 sets `t.arrived` on the in-memory `t` object at `call()` entry, and consumes `r.at` on restart replay in `loadTurn`.

### 3.2 Host Wall-Clock Semantics & Two-Sided Clamping
`b.now()` defaults to `Date.now` (`server/remote/host/broker-state.mjs:58`), the host's wall clock. Because wall clocks can jump forward or backward (NTP synchronization or VM suspend/resume):
1. `elapsed` is clamped against backward jumps: `elapsed = Math.max(0, now - arrived)`.
2. `remaining` is clamped between 0 and 100 s: `remaining = Math.min(REMOTE_READ_TIMEOUT_MS, Math.max(0, REMOTE_READ_TIMEOUT_MS - elapsed))`.
This guarantees that remaining duration never goes negative and never exceeds 100 s.

### 3.3 Latency Budget & Unverified Assumptions
$$\tau_{\text{client}} = \tau_{\text{read}} + T_{\text{margin}} = 100\,\text{s} + 20\,\text{s} = 120\,\text{s}$$
* **Kiro harness deadline (120 s):** Sourced from Kiro Configuration Reference under `McpServers field` (`requestTimeout: 120000`).
* **Safety margin ($T_{\text{margin}} = 20\,\text{s}$):** An engineering assumption pending benchmark confirmation under #591. It provides a safety envelope for snapshot read, string formatting, shim JSON-RPC delivery, and journal fsync.

---

## 4. Timer Lifecycle (`armReadTimer`)

### 4.1 Clamped Scheduling & Swallowed Deadlines
In `server/remote/host/broker-tools.mjs`:
```javascript
import { REMOTE_READ_TIMEOUT_MS } from '../../../shared/limits.mjs';
// settled and settleOffline are sibling exports within broker-tools.mjs

/**
 * Arms the 100s deadline timer for an admitted read invocation.
 * Clamps remaining time against b.now() - t.arrived.
 * @param {Broker} b @param {Tool} t
 */
export function armReadTimer(b, t) {
  if (b.closed || settled(t) || t.route !== 'read' || !b.attached() || t.timer) return;

  const now = b.now();
  const arrived = t.arrived ?? now;
  const elapsed = Math.max(0, now - arrived);
  const remaining = Math.min(REMOTE_READ_TIMEOUT_MS, Math.max(0, REMOTE_READ_TIMEOUT_MS - elapsed));

  if (remaining === 0) {
    settleOffline(b, t).catch(b.log);
    return;
  }

  t.timer = b.timers.setTimeout(() => {
    t.timer = undefined;
    settleOffline(b, t).catch(b.log);
  }, remaining);
}
```

*Swallowed Deadlines:* When a timer fires, it clears `t.timer = undefined` before invoking `settleOffline`. If a failed live journal write occurs while attached after the timer already fired (as specified in `settle.md` §5), subsequent invocations of `armReadTimer` find `t.timer === undefined`, compute `remaining === 0`, and settle offline immediately without delay.

### 4.2 Call Sites for `armReadTimer`
1. **Fresh attached read (`queueTool`):** In `server/remote/host/broker-tools.mjs`, after `take` and `await t.saved` succeed, and after the `settled(t)` check: if `route === 'read'`, `armReadTimer(b, t)` is called before `b.toPostbox('tool', toolBody(t))`.
2. **Re-connection resend (`onHello`):** In `server/remote/host/broker-postbox.mjs:55`, inside the unreplied loop after `gone` pruning.
   **Crucial Expiry Check:** To prevent sending an expired call to the new Postbox driver while simultaneously settling it offline, hello checks expiry *before* sending:
   ```javascript
   for (const t of b.tools.values()) {
     if (!settled(t)) {
       if (t.route === 'read') {
         const elapsed = Math.max(0, b.now() - (t.arrived ?? b.now()));
         if (elapsed >= REMOTE_READ_TIMEOUT_MS) {
           settleOffline(b, t).catch(b.log);
           continue;
         }
       }
       send('tool', toolBody(t));
       if (t.route === 'read') armReadTimer(b, t);
     }
   }
   ```

### 4.3 Timer Reclamation
Timers are cleared (`b.timers.clearTimeout(t.timer); t.timer = undefined;`) when:
1. `settleOffline(b, t)` claims the call (handled by Part 3 in step 2 of `settleOffline`).
2. A live reply completes in `onReply`:
   ```javascript
   t.replied = true;
   t.args = null;
   if (t.timer) {
     b.timers.clearTimeout(t.timer);
     t.timer = undefined;
   }
   ```
   **Ordering Discipline:** The timer is cleared *only after* `t.replied = true` succeeds. If a live journal write fails, `main` leaves the call waiting (`onReply` clears `t.replying` and returns `internal`). Leaving `t.timer` armed preserves the 100 s deadline for subsequent settlement.
3. The broker daemon closes in `broker.mjs:close()`:
   ```javascript
   for (const t of b.tools.values()) {
     if (t.timer) b.timers.clearTimeout(t.timer);
   }
   ```

---

## 5. Replay Restoration & Integer Validation

When the daemon restarts, `loadTurn(b, turn)` in `server/remote/host/broker-replay.mjs` restores `b.tools` from `tools.jsonl`.
* For `op: 'call'` records, `t.arrived` is restored from `r.at` (which carries `t.arrived` from Part 3's `queueTool` write).
* To prevent `NaN` or invalid timer calculations from corrupt or hand-edited records, the restoration validates integer bounds:
  ```javascript
  arrived: Number.isSafeInteger(r.at) && r.at >= 0 ? r.at : b.now(),
  ```
* When hello runs, if the restored call has an age $\ge 100\,\text{s}$, the pre-send check in `onHello` (step 4.2) settles it offline immediately without sending `tool` to Postbox.

---

## 6. System Invariant

### Invariant 1: Strictly Bounded Read Execution Latency
For every read invocation $T$ admitted by the host broker, the deadline timer is scheduled for at most 100 s after invocation arrival on the host clock ($\Delta t \le 100\,\text{s}$), and offline settlement completes within $T_{\text{margin}} = 20\,\text{s}$ of the timer firing:
* **Live reply:** Returns live transcript data when Postbox responds before 100 s. A live reply whose journal append is already in flight under `t.replying` completes within $T_{\text{margin}} = 20\,\text{s}$ and wins over timer expiry via `settled(t)`.
* **Link severance:** Disconnection triggers immediate offline settlement via `driverLost()`.
* **Deadline expiration:** If neither live reply nor link severance occurs, the timer fires at $\Delta t = \min(100\,\text{s}, \max(0, 100\,\text{s} - (b.\text{now}() - t.\text{arrived})))$ and calls `settleOffline(b, t)`. Offline query and dispatch complete within $T_{\text{margin}} = 20\,\text{s}$.

---

## 7. Specifications Owned by Part 1

The following specifications in `tests/remote-read-contract.test.mjs` are authored and verified by Part 1:

| Spec ID | Name | Observable Verification Assertion |
|---|---|---|
| **T02** | 100s deadline expiration via fake clock | Injects fake clock; advances 100 s; asserts timer triggers `settleOffline` and shim receives snapshot result with `(Read offline as of this turn’s start; earlier or changed items may be missing.)`. |
| **T10** | Restart replay after log failure | After a failed `reply` write and daemon restart, the call replays unsettled from `tools.jsonl`. When hello runs, if its age is $< 100\,\text{s}$, hello resends it to Postbox; if its age is $\ge 100\,\text{s}$, it settles offline immediately without being sent. |
| **T11** | Replayed unsettled read arms timer anchored on `at` | Injects synchronized fake clock (`now` and `timers`). Call 60 s old at hello settles 40 s after hello; call $\ge 100\,\text{s}$ old settles immediately on hello without sending `tool` frame. Negative/non-numeric `at` safely defaults to `b.now()`. Wall-clock backward jump clamps remaining time $\le 100\,\text{s}$. |
| **T13** | Negative control (live reply at 50 ms) | Live response arrives at 50 ms; asserts timer is cleared after `t.replied = true` and response delivered without offline disclaimer. |
| **T14** | Zero leaked timers assertion | Asserts 0 armed timers survive in `b.timers` across all settlement, link drop, and teardown paths. |

---

## 8. Integrated Specification Cross-Reference

Track 4 specifications are partitioned across the three modular design parts:

* **Part 2 (`link.md` / `tests/remote-link-loss.test.mjs`, @engineer):**
  - **L1 (T01):** Driver socket ends: parked read answered from snapshot at once (S2b).
  - **L2 (T05):** Shim socket ends: no read is settled (guard).
  - **L3 (T03):** Same-instance hello before old socket close: read stays waiting (S3a).
  - **L4:** Old socket close before hello: read settles offline once, hello resends nothing (S2b).
  - **L5 (T04):** Takeover hello: old driver's reads settle offline before new driver resend (S3b).
  - **L6:** Busy hello leaves driver and reads alone (guard).
  - **L7:** Two closes of one driver call `driverLost` once.
  - **L8 (T12):** Mutating `ask` and `queue` calls untouched by `driverLost`.
  - **L5b:** Synchronous claim check right after `old.close('taken-over')`.
  - **L9 (gpt's T21):** Close landing while read is in `readLocal`.
* **Part 3 (`settle.md` / `tests/remote-read-contract.test.mjs`, @gpt):**
  - **T06:** Fallback broadcast to surviving shims via `toShims`.
  - **T07:** Race: Live reply during snapshot read discards live reply.
  - **T08:** Race: Live reply during log append discards live reply.
  - **T09:** Log write failure fail-open delivery (handles error string without throwing).
  - **T12:** Mutating `ask` tools (`wake_agent`) never settle offline.
  - **T15:** Journal ordering (`call` record fsync completes before `reply`).
  - **T17:** Admission link drop during call save leaks no timer and sends 0 frames.
  - **T18:** Fresh read while detached routes through `take` and registers in `b.tools`.
  - **T19:** Detached read exempt from waiting call limit (256 calls).
  - **T20:** Detached read refused on full turn record (256 MiB).
  - **T21:** Takeover hello during `readLocal` does not resend call.
  - **T22:** Late live reply after claim receives `no-tool` without waiting.
  - **T23:** Offline read longer than `replyChars` cut consistently before `OFFLINE_NOTE` append across record and wire.
  - **T24:** Live `written` failure while detached settles offline.
  - **T25:** Shim `send` throw does not halt broadcast to remaining shims.
* **Part 1 (`deadline.md` / `tests/remote-read-contract.test.mjs`, @gemini):**
  - **T02, T10, T11, T13, T14** as defined in Section 7.
