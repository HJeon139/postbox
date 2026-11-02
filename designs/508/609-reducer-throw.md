# #609 and #610: an event the reducer rejects

| | |
|---|---|
| **Status** | Revision 4, approved by the person on 2 November 2026, after critic's reads of revisions 1 to 3 and gpt's of revision 1. Revision 2 took in gpt's read: what the page holds, a stand-in that carries nothing to the page, a rejection that is durable for emits, and the commit case. Revision 3 took in critic's first read: the batch a crashing release loses, the two lines a rejected commit leaves, the commit contract in `design.md` §6.6, and a bound on what's kept. Revision 4 takes in critic's second: the contract spec derives its inputs, and the reloads after a rejection are stated. Amends `storage-design.md` §6 (the writer) and Q8, and `design.md` §6.6 |
| **Issues** | #609 (a commit and a replay), #610 (an emit). One cause, so one fix |

## The invariant

**Every event the store numbers is in the log and accounted for on every load.** Either it is applied, or the store holds it as rejected with a named error that load reports. A rejected event leaves the server's state, its replay and the page's state the same. Numbering never skips, and no reducer throw closes the store, crashes the writer or refuses a load.

## What happens on `main` (`88af074f`)

`Store.record()` calls the shared reducer (`apply` in `shared/state.mjs`) after `sequence()` has numbered the event, and only decrements `ahead` once `apply` returns. A throw at each of these points lands somewhere different. I ran all four on `main`:

| Where `apply` throws | On `main` |
|---|---|
| `emit()` | The caller gets the error and the event isn't written, but `ahead` stays up. The next event skips a seq, and the next load warns “the event log lost events 2 to 2”, which is false. |
| A held emit at its release (`release()`, in the writer's `writeLines`) | `release()` runs outside `writeLines`' `try`, so the throw escapes the writer's loop and **the process exits** (an uncaught error). The lines already collected in that batch, earlier held emits that were applied and broadcast, are never appended, so they're lost from the log as well. The held count never comes down, so if the process survived, every later emit would stay held. |
| A commit, after its fsync (`applyCommits`) | The line is durable. The writer's catch closes the store to commits (“Postbox can't write its event log”), although nothing failed to write. |
| Replay of that line (`applyGroup` in `store-replay.mjs`) | The raw error rejects `load()`, so **the store refuses every load** until someone edits the log. |

Today, only an event of an unknown type and a few data errors make the reducer throw, and no production path sends either. A1b adds reducer cases with more ways to throw. A step patch on an item whose activity has no steps already throws.

## The one policy: hold the event as rejected

**The reducer's contract: a handler that throws leaves the state as it was.** It checks before it changes anything. On `main`, I applied each of the 22 types to a fresh state with `undefined`, `null` and `{}` as its data, and a step patch to an activity with no steps. Every throw came before any change but one: `glossary` with no `entry` makes `glossary[undefined]` and then throws. This change fixes that handler to read `d.entry` first. A spec holds each handler to the contract, and derives its inputs instead of listing them. For each event type it takes one valid payload, from a table of one per type, each taken from an existing reducer spec. It then applies every payload with one key left out (at every depth), plus `undefined`, `null` and `{}`, to a fresh state that holds what the valid payload needs. Whenever `apply` throws, the state's JSON must be byte-equal to before. Once PR 1's `EVENTS` table lands (design-a1-pr1), the spec runs over its entries, and a type with no valid payload in the table fails it. So a new type comes with its inputs.

When `apply` throws inside `record()`, the store keeps the event as rejected:
- **Numbering:** `record()` finishes its bookkeeping (`state.seq`, `ahead`, `version`), so the next event takes the next seq.
- **In memory and on the wire:** a stand-in, `{ seq, type: 'rejected', data: {} }`, is kept for `since()` and broadcast. It carries nothing: the reducer's message can quote what it was given, and once A1b's records exist that can be private. The shared reducer's `rejected` case does nothing. Under PR 1's table, `rejected` is an entry with a no-op handler and `public: false`, so the page gets a `cursor` with the seq. Whichever PR lands second adds the entry.
- **In the log, for an emit and a held release:** the stand-in is what's written, carrying the original for the record: `{ seq, type: 'rejected', data: { event: { type, data }, error } }`. These are applied before they are written, so every build replays the line as rejected, whatever a later reducer would do with the original, and wherever the last snapshot falls.
- **In the log, for a commit:** the line was written and fsynced before it was applied, so the original is what's on disk. The same build replays it to the same rejection. A later build whose reducer accepts it applies it, but only if it's above the last snapshot. That difference is accepted, not fixed: a commit's builder runs before anything is numbered and is where a commit is refused whole, and A1b gets a spec that every batch its builder accepts applies without a throw (gpt carries it into A1b's design).
- **Reported, and bounded:** `store.rejected` is `{ count, first }`: the number rejected, and the first 20 as `{ seq, type, error }`, as `store.lost` keeps a range and a count. The store logs one named error per rejection. Load rebuilds it from the stand-ins and the commits that throw again, and reports it once, as Q8 does for lost history. Like `lost`, it is rebuilt only from the lines above the last snapshot, so a rejection the snapshot already covers isn't reported again on a later load.
- **Two lines for one seq.** For a rejected seq, the broadcast line and the log line differ. `since()`, the `KEEP_EVENTS` backlog and the broadcast hold the empty stand-in. The log holds the stand-in with the original inside it, for an emit or a release, or the original line, for a commit. `storage-design.md` §6 says so.
- **Reserved:** no producer may emit `rejected`. `emit()` and a commit refuse the type before numbering, which a spec checks, as PR 1 reserves `cursor`.

**A backstop for the page.** If a handler breaks the contract and changes part of the state before it throws, the server keeps that change but the page doesn't. So a rejection also sends `resync` to every live stream, and `since()` from below a rejected seq answers `resync` in place of a backlog. The page then refetches `/api/state`. Rejections are rare, so the cost doesn't matter, and the page never trusts a handler. One consequence to expect: until a rejected seq leaves the `KEEP_EVENTS` backlog, every page that reconnects from before it reloads in full. A run of full reloads after a rejection is this, not a bug. The server's own replay does rely on the contract for an emit's stand-in, which is why the spec holds every handler to it.

**What the caller hears:**
- **`emit()`** still throws, now with `{ code: 'EREJECTED', seq }`, so a bug is still loud where it happens.
- **A commit** rejects with the same error. It doesn't close the store, because the write succeeded. In a commit of several events, the others are applied in order around the rejected one, which by the contract changes nothing. So the commit is applied in part, and its error names the rejected seq.
  - **This amends the commit contract.** `design.md` §6.6 says a commit is applied whole after its sync. It gains: “unless the reducer rejects one of its events, which is then held as rejected (#609), while the rest apply”. Its bullet “a bad line in the middle of a segment refuses to start” gains “a line the reducer rejects doesn't: it's held as rejected”.
  - **Why not reject the commit whole on the server too:** that means undoing the events already applied. Without a copy of the state taken before them, which is the cost the other policy refuses, nothing can undo them. And a builder that validates is already where a commit is refused whole, before anything is numbered.
- **A held emit** is rejected at its release the same way. The writer's loop carries on, and the held count comes down.

## The other policy, and why not

**Refuse before writing:** apply each event to a candidate copy of the state first, and number and write it only if that succeeds.
- **The cost:** a copy of the state for each emit. A streaming reply emits one event per chunk, and the state is tens of MB, so that cost is too high.
- **Commits only:** a candidate for commits alone would still leave emits, held releases and every line already on disk to the second policy.
- **Replay:** it does nothing for a line already in an older log, which would still refuse the load.

So it would mean two policies, where holding the event as rejected is one, at the one place every event passes through.

## Failure table rows (for `storage-design.md` §6)

| Failure | Detected by | What happens | The person sees |
|---|---|---|---|
| The reducer throws on an emit, before any write | `record()`'s catch | numbered; the stand-in is written and kept; the caller gets `EREJECTED`; the streams resync | a refetch; one logged error |
| The reducer throws on a held emit at its release | the same | the same; the writer goes on | a refetch; one logged error |
| The reducer throws on a commit's event after its fsync | the same | the original stays in the log; the commit is applied in part and rejects with `EREJECTED`; the store stays open; the streams resync | a refetch; one logged error |
| A line on disk throws on replay | the same, in `applyGroup` | load completes, with the line held as rejected | once, as Q8's notice: “N events couldn't be applied” |
| A producer emits `rejected` | `emit()` and the commit path, before numbering | refused; nothing numbered | nothing; the caller gets the error |
| A handler changes state, then throws | the contract spec, in the gate | the spec fails; in a release that missed it, the page resyncs, and the server's replay of the stand-in can differ | a refetch |

## Specs, failing first on `main`

1. An emit that throws, then a good emit, then a reload: the seqs run on with no gap, load reports nothing lost and one rejected, and the log holds the stand-in.
2. A commit held in its fsync, a good emit, an emit that throws and another good emit held behind it, then the release: no crash, both good emits reach the disk, the next emit gets the next seq, and the held count is 0.
3. A commit whose event throws: the store stays writable, the commit rejects with `EREJECTED`, and a reload loads and reports one rejected event.
4. A log written with a line that throws: load completes, and the line is in `store.rejected`.
5. A step patch on an item whose activity has no steps (a data error, not an unknown type): the same as 1.
6. The page: a live stream gets `resync` after a rejection, and `since()` from below the rejected seq answers `resync`. The stand-in on the wire has empty `data`.
7. `rejected` is reserved: an emit or a commit of it is refused, and nothing is numbered.
8. The contract: for each event type, its valid payload with each key left out, and `undefined`, `null` and `{}`, each leave the state's JSON byte-equal whenever `apply` throws. On `main` it fails for `glossary` (no `entry`). The spec reports any other type it finds.
9. The bound: 25 rejections keep a count of 25 and the first 20.

## Not in this change

- **The page:** it shows nothing of `store.rejected` until PR 1b's status line, which shows `store.lost` too.
- **Retry's reload:** it runs `load()`, so the same path covers it.
