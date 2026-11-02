# #582: a read answered from the snapshot when Postbox is gone or slow

The design is three files, one per part, each signed on its own. Read this page first; it holds the interfaces the parts agree on, so none of them rewrites another.

| Part | File | Scope |
|---|---|---|
| 1. Deadline and replay | [`deadline.md`](deadline.md) | `REMOTE_READ_TIMEOUT_MS`, `armReadTimer`, `arrived` from the call record's `at`, the clock-jump clamp |
| 2. Link loss | [`link.md`](link.md) | `Conn.close(reason)`, the hello's `'replaced'` and `'taken-over'`, `driverLost` |
| 3. Settle path | [`settle.md`](settle.md) | `settleOffline`, the claim, the journal, `toShims`, admission, the `io` seam, `settled(t)` |

## Interfaces

- **`settleOffline(b, t): Promise<void>`** (Part 3). Safe to call any number of times; only the first call settles. Parts 1 and 2 call it and do nothing else to `t`.
- **Which test each caller uses.** `settled(t)` (Part 3) is `t.replied || !!t.replying`: a call is taken, by an offline answer or by a live reply being written. `settleOffline`, `onReply`, `driverLost` and the timer use it, so none of them claims a call that is already being answered. **The hello's resend uses `t.replied || t.offline` instead:** it must skip a read being answered offline, but not a call whose live reply is only being written, because that write can still fail and then nothing else would send the call. `driverLost` skips a read mid live-write too; if the write fails, `onReply` settles it offline when the link is down.
- **`driverLost(b): void`** (Part 2) calls `settleOffline` for every unsettled read, in the same tick as the connection's close.
- **`armReadTimer(b, t): void`** (Part 1) arms or re-arms one timer, which calls `settleOffline` when it fires.
- **Fields on `t`:** `replied`, `replying`, `offline`, `result`, `saved` are Part 3's; `timer`, `arrived` are Part 1's. No part writes another part's fields, with one exception: Part 1 arms `t.timer`, and Part 3's `settleOffline` and `onReply` clear it (and so does the broker's `close()`), so a settled call never keeps a timer.

## Order

Part 3 first, then Parts 1 and 2 (either order). They were built in that order on one branch, so the PR lands them together.

## Known limits, stated once

- A resending connection can receive the same answer text twice (`settle.md` §11); a shim keeps the first.
- A reply record written after admission, for a read that was attached and then answered offline, can pass the journal's size budget slightly, because the budget is checked at admission only. It either lands or logs a failure, and changes nothing the shim saw.
- After a takeover, the old session's unsettled `ask` and `queue` calls are still sent to the new Postbox. That is existing behavior, filed as #612, and this change does not touch it.
- The same vacuous check exists on `main`, in `tests/remote-read-contract.test.mjs`; this change leaves that file as it is.
