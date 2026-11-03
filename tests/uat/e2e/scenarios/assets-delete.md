# Assets and a deleted conversation: writes across a delete, its Undo, and the purge

- persona: A team lead who deletes conversations by mistake and expects Undo to give everything back, and who wants a deleted one to stay deleted, with nothing of it still being written. Writes short messages.
- agents: researcher, critic
- project: Login cleanup
- conversation: Deletes and Undo
- steps: 25

researcher and critic are in the room, on Claude Code, with the six asset tools (#516 S3). This is the acceptance run for #722, #723 and #724. Run it locally, then again with researcher on a host (`--host <host1> --place researcher=host1`), where phase 3 runs and phases 1 and 6 are skipped. The tester’s `conversation` action acts on the conversation that’s open: `{conversation: "delete", undo_after?}`, `{conversation: "undo"}`, `{conversation: "new", agents}` and `{conversation: "open", title}`, and as an interrupt during a turn, `{after, do: "conversation", conversation: "delete", undo_after?}`. A local run can restart Postbox with `fault {fault: "restart-postbox"}`. A phase that lets a conversation be purged deletes a second one it started, so this run’s own conversation, “Deletes and Undo”, survives. The checks `asset-content-in-store`, `asset-room-orphan` and `turn-in-deleting-conversation` read every run’s records. Deleting a conversation stops every turn in it, and Postbox refuses the person’s messages until Undo, so only a delivery that isn’t the person’s message, or a host whose link is down, can reach the refusals for a conversation being deleted (`deleting`) or deleted (`no-conversation`). The edges no run can force are decided by tests: an erase between storing a write’s bytes and its commit (tests/asset-room-exists.test.mjs); content in other encodings (tests/asset-content-kept-out.test.mjs); and a topic thread deleted alone, which erases none of its conversation’s assets (tests/asset-failures.test.mjs, F11, “a topic alone erases none”). No person can delete a topic thread alone: Postbox refuses it with a 409, saying to delete the conversation it belongs to instead.

## Phase 1: Writes, then a delete past its purge

Local runs only; in the host run, skip it. Start a second conversation with researcher (`{conversation: "new", agents: ["researcher"]}`). Ask researcher, in one turn, to write `notes/log.md` 20 times, adding a line each time, with `sleep 1` in its folder between writes. About 5 seconds in, delete that conversation (the interrupt `{after: 5, do: "conversation", conversation: "delete"}`), and wait 15 seconds, past its Undo. Then open “Deletes and Undo” again (`{conversation: "open", title: "Deletes and Undo"}`).

Pass if the turn stops at the delete, and the run’s records hold no `asset.version` after the conversation’s `asset.erase`; and `asset-room-orphan` and `turn-in-deleting-conversation` find nothing for it. Fail, and file it, if a version is published after the erase, or a room index or an asset is left for the deleted conversation.

## Phase 2: A wake in the Undo window

Expected to fail until #725 is fixed: a wake delivered during the window starts a turn. If it fails that way, name #725 and file nothing new.

In “Deletes and Undo”, ask researcher to schedule a wake in 1 minute whose note says to publish `notes/wake.md` with one line, and to quote Postbox’s answer, which gives the time it wakes. About 4 seconds before that time, delete the conversation with Undo 7 seconds later (`{conversation: "delete", undo_after: 7}`). The wake then falls due about 4 seconds into the 10-second window, and Undo lands 3 seconds before the purge.

Pass if the run’s records show the wake was due between the delete and the Undo, no turn ran while the conversation was being deleted, and after Undo the wake is delivered and `notes/wake.md` is published. If the wake wasn’t due inside the window, say so: the phase is unverified, not passed, and #725’s spec decides it (tests/conversation-delete-turns.test.mjs, in its pull request). Fail, and file it, if a turn runs in the window (#725), or the wake is lost after Undo.

## Phase 3: The host’s link down across the delete

The host run only; locally, skip it. Start a second conversation with researcher (`{conversation: "new", agents: ["researcher"]}`). Ask researcher, on host1, in one turn, to write `notes/host-log.md` 20 times with `sleep 1` between writes, quoting each answer. About 4 seconds in, kill its ssh connection (fault kill-ssh, target host1). While the link is down, delete that conversation (the interrupt `{after: 1, do: "conversation", conversation: "delete"}`), then wait past its purge, and open “Deletes and Undo” again (`{conversation: "open", title: "Deletes and Undo"}`).

Pass if any call that reaches Postbox after the reconnect is refused: inside the Undo window, saying the conversation is being deleted; after the purge, saying it was deleted, and its assets with it. Nothing is published after the erase. The run’s records decide whether a call arrived after the delete; if none did, say so: the phase is unverified, not failed, and tests/asset-room-exists.test.mjs decides the refusals. Fail, and file it, if a version is published after the erase, or a refusal points at `list_assets`.

## Phase 4: Delete, then Undo

In “Deletes and Undo”, ask researcher to publish `notes/keep.md` with one line, and to say the asset’s id. Delete the conversation and press Undo 3 seconds later (`{conversation: "delete", undo_after: 3}`). Then ask researcher to list the assets, and to write `notes/keep.md` again from its newest version.

Pass if `notes/keep.md` is still listed after Undo, and the write publishes version 2. Fail, and file it, if anything is missing after Undo, or the write is refused.

## Phase 5: A second conversation can’t see them

Start a second conversation with researcher (`{conversation: "new", agents: ["researcher"]}`). Its researcher is a new session, with no record of phase 4, so give it the id researcher said there. Ask it to list the assets there, then to read the asset by that id. Then open “Deletes and Undo” again (`{conversation: "open", title: "Deletes and Undo"}`).

Pass if the list is empty, and the read is refused as not in this conversation. Fail, and file it, if any asset of “Deletes and Undo” is listed or read.

## Phase 6: A restart after a purge

Local runs only. Restart Postbox (`fault {fault: "restart-postbox"}`).

Pass if the load deleted the files of phase 1’s erased conversation, and the run’s records hold their `asset.released`; and the assets of “Deletes and Undo” still read back. Fail, and file it, if an erased conversation’s file is left, or a kept asset’s file is gone.
