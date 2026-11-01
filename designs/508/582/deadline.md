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
- preserving `at: t.arrived` in the `call` journal record in `queueTool` so replay anchors on true arrival time;
- restoring `arrived` from the journal's `r.at` in `loadTurn` with integer validation;
- checking expiry before sending in hello resend in `broker-postbox.mjs` and re-arming unexpired reads;
- clearing `t.timer` only after `t.replied = true` on live reply and on broker close;
- the deadline and replay test specifications (T02, T10, T11, T13, T14, T16).

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
Kiro's client-side 120-second per-call timer (`requestTimeout: 120000` under `McpServers field` in `kiro.dev/docs/custom-agents/configuration-reference`) starts when the agent CLI emits the call. In `server/remote/host/broker-tools.mjs`, `call()` awaits `refusal()` and `prepare()` before constructing `t`.

To guarantee that the 100-second deadline strictly bounds elapsed time across all pre-admission waits:
1. `call(b, c, turn, m)` captures `const arrived = b.now();` as its very first statement.
2. When admitted and constructed, `t` stores `arrived`.
3. In `queueTool`, `record()` is given explicit `at: t.arrived`:
   ```javascript
   t.saved = record(b, t.turn, 'tools', {
     op: 'call',
     id: t.id,
     name: t.name,
     route: t.route,
     args: t.args,
     at: t.arrived,
   }).then(
     () => '',
     (e) => unrecorded(t.name, e),
   );
   ```
   `record()` (`broker-records.mjs:22`) honors `rec.at ?? b.now()`, ensuring `tools.jsonl` stamps the true invocation arrival time rather than the post-admission timestamp.

### 3.2 Host Wall-Clock Semantics & Two-Sided Clamping
`b.now()` defaults to `Date.now` (`server/remote/host/broker-state.mjs:58`), the host's wall clock. Because wall clocks can jump forward or backward (NTP synchronization or VM suspend/resume):
1. `elapsed` is clamped against backward jumps: `elapsed = Math.max(0, now - arrived)`.
2. `remaining` is clamped between 0 and 100 s: `remaining = Math.min(REMOTE_READ_TIMEOUT_MS, Math.max(0, REMOTE_READ_TIMEOUT_MS - elapsed))`.
This guarantees that remaining duration never goes negative and never exceeds 100 s.

### 3.3 Latency Budget & Unverified Assumptions
$$\tau_{\text{client}} = \tau_{\text{read}} + T_{\text{margin}} = 100\,\text{s} + 20\,\text{s} = 120\,\text{s}$$
* **Kiro harness deadline (120 s):** Sourced from Kiro Configuration Reference under `McpServers field`.
* **Safety margin ($T_{\text{margin}} = 20\,\text{s}$):** An engineering assumption pending benchmark confirmation under #591. It provides a safety envelope for snapshot read, string formatting, shim JSON-RPC delivery, and journal fsync.

---

## 4. Timer Lifecycle (`armReadTimer`)

### 4.1 Clamped Scheduling
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
3. **Resent call while attached:** If a shim resends a call that is still waiting, `armReadTimer` ensures the timer remains armed with the clamped remaining duration.

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
* For `op: 'call'` records, `t.arrived` is restored from `r.at` (which carries `t.arrived` from step 3.1).
* To prevent `NaN` or invalid timer calculations from corrupt or hand-edited records, the restoration validates integer bounds:
  ```javascript
  arrived: Number.isSafeInteger(r.at) && r.at >= 0 ? r.at : b.now(),
  ```
* When hello runs, if the restored call has an age $\ge 100\,\text{s}$, the pre-send check in `onHello` (step 4.2) settles it offline immediately without sending `tool` to Postbox.

---

## 6. System Invariant

### Invariant 1: Strictly Bounded Read Execution Latency
For every read invocation $T$ admitted by the host broker, the deadline timer fires $\le 100\,\text{s}$ after invocation arrival on the host clock:
$$b.\text{now}() - t.\text{arrived} \le \tau_{\text{read}} = 100\,\text{s}$$
* **Live reply:** Returns live transcript data when Postbox responds before 100 s. A live reply whose journal append is already in flight under `t.replying` completes within $T_{\text{margin}} = 20\,\text{s}$ and wins over timer expiry via `settled(t)`.
* **Link severance:** Disconnection triggers immediate offline settlement via `driverLost()`.
* **Deadline expiration:** If neither live reply nor link severance occurs, the timer fires at $\Delta t = \min(100\,\text{s}, \max(0, 100\,\text{s} - (b.\text{now}() - t.\text{arrived})))$ and calls `settleOffline(b, t)`. Offline query and dispatch complete within $T_{\text{margin}} = 20\,\text{s}$.

---

## 7. Specifications Owned by Part 1

The following specifications in `tests/remote-read-contract.test.mjs` are authored and verified by Part 1:

| Spec ID | Name | Observable Verification Assertion |
|---|---|---|
| **T02** | 100s deadline expiration via fake clock | Injects fake clock; advances 100 s; asserts timer triggers `settleOffline` and shim receives snapshot result with `(Read offline as of this turn’s start; earlier or changed items may be missing.)`. |
| **T10** | Restart replay after log failure | Replays unsettled call; resends to 0 shims; reconciles journal record. |
| **T11** | Replayed unsettled read arms timer anchored on `at` | Injects synchronized fake clock (`now` and `timers`). Call 60 s old at hello settles 40 s after hello; call $\ge 100\,\text{s}$ old settles immediately on hello without sending `tool` frame. Negative/non-numeric `at` safely defaults to `b.now()`. Wall-clock backward jump clamps remaining time $\le 100\,\text{s}$. |
| **T13** | Negative control (live reply at 50 ms) | Live response arrives at 50 ms; asserts timer is cleared after `t.replied = true` and response delivered without offline disclaimer. |
| **T14** | Zero leaked timers assertion | Asserts 0 armed timers survive in `b.timers` across all settlement, link drop, and teardown paths. |
| **T16** | Resent call while attached arms timer | Shim resends waiting call; fake clock advances 100 s; asserts resent call settles offline on schedule. |

---

## 8. Integrated Specification Cross-Reference

Track 4 specifications are partitioned across the three modular design parts:

* **Part 2 (`link.md` / `remote-link-loss.test.mjs`, @engineer):**
  - **T01 / L1:** Immediate offline fallback on link drop (S2b).
  - **T03 / L2:** Same-instance replacement hello keeps reads waiting for live reply (S3a, hello before close).
  - **T04 / L5:** Foreign takeover triggers immediate offline fallback for prior session reads (S3b).
  - **T05 / L6:** Non-driver socket closure does not trigger `driverLost()`.
  - **L3:** Same-instance replacement guard.
  - **L4:** Close before hello fallback (S2b ordering).
  - **L7:** Multiple detached reads settle once on link drop.
  - **L8:** Mutating and ask tools untouched by `driverLost()`.
* **Part 3 (`settle.md` / `remote-read-contract.test.mjs`, @gpt):**
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
* **Part 1 (`deadline.md` / `remote-read-contract.test.mjs`, @gemini):**
  - **T02, T10, T11, T13, T14, T16** as defined in Section 7.
