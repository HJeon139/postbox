# Assets and a deleted conversation: writes across a delete, its Undo, and the purge

- persona: A team lead who deletes conversations by mistake and expects Undo to give everything back, and who wants a deleted one to stay deleted, with nothing of it still being written. Writes short messages.
- agents: researcher, critic
- project: Login cleanup
- conversation: Deletes and Undo
- steps: 25

researcher and critic are in the room, on Claude Code, with the six asset tools (#516 S3). This is the acceptance run for #722, #723 and #724. Run it locally, then again with researcher on a host (`--host <host1> --place researcher=host1`), where phase 1c runs and phase 1 is skipped. It needs the tester’s `conversation` action (delete, undo, new) and `restart-postbox` in a local run. The checks `asset-content-in-store`, `asset-room-orphan` and `turn-in-deleting-conversation` read every run’s records. Deleting a conversation stops every turn in it, and Postbox refuses the person’s messages until Undo, so only a delivery that isn’t the person’s message, or a host whose link is down, can reach the refusals for a conversation being deleted (`deleting`) or deleted (`no-conversation`). The edges no run can force are decided by tests: an erase between storing a write’s bytes and its commit (tests/asset-room-exists.test.mjs), and content in other encodings (tests/asset-content-kept-out.test.mjs).

## Phase 1: Writes, then a delete

Local runs only; in the host run, skip it. Ask researcher, in one turn, to write `notes/log.md` 20 times, adding a line each time, with `sleep 1` in its folder between writes. About 5 seconds in, delete the conversation (conversation, do delete), and wait 15 seconds, past its Undo.

Pass if the turn stops at the delete, and the run’s records hold no `asset.version` after the conversation’s `asset.erase`; and `asset-room-orphan` and `turn-in-deleting-conversation` find nothing for it. Fail, and file it, if a version is published after the erase, or a room index or an asset is left for the deleted conversation.

## Phase 2: A wake in the Undo window

Expected to fail until #725 is fixed: a wake delivered during the window starts a turn. If it fails that way, name #725 and file nothing new.

Open a new conversation with researcher and critic (conversation, do new). Ask researcher to schedule a wake in 1 minute whose note says to publish `notes/wake.md` with one line. About 52 seconds later, delete the conversation (conversation, do delete), and press Undo 12 seconds after that (conversation, do undo).

Pass if no turn runs while the conversation is being deleted, and after Undo the wake is delivered and `notes/wake.md` is published. Fail, and file it, if a turn runs in the window (#725), or the wake is lost after Undo.

## Phase 3: The host’s link down across the delete

The host run only; locally, skip it. In the conversation from phase 2, ask researcher, on host1, in one turn, to write `notes/host-log.md` 20 times with `sleep 1` between writes, quoting each answer. About 4 seconds in, kill its ssh connection (fault kill-ssh, target host1). While the link is down, delete the conversation (conversation, do delete), then wait past its purge.

Pass if any call that reaches Postbox after the reconnect is refused: inside the Undo window, saying the conversation is being deleted; after the purge, saying it was deleted, and its assets with it. Nothing is published after the erase. The run’s records decide whether a call arrived after the delete; if none did, say so: the phase is unverified, not failed, and tests/asset-room-exists.test.mjs decides the refusals. Fail, and file it, if a version is published after the erase, or a refusal points at `list_assets`.

## Phase 4: Delete, then Undo

In the conversation from phase 2 (or a new one, in the host run), ask researcher to publish `notes/keep.md` with one line. Delete the conversation (conversation, do delete), and press Undo within its 10 seconds (conversation, do undo). Then ask researcher to list the assets, and to write `notes/keep.md` again from its newest version.

Pass if `notes/keep.md` is still listed after Undo, and the write publishes version 2. Fail, and file it, if anything is missing after Undo, or the write is refused.

## Phase 5: A second conversation can’t see them

Open a second conversation with researcher (conversation, do new). Ask it to list the assets there, then to read `notes/keep.md` by the id it had in the conversation from phase 4.

Pass if the list is empty, and the read is refused as not in this conversation. Fail, and file it, if any asset of the conversation from phase 4 is listed or read.

## Phase 6: A topic thread deleted alone

Back in the conversation from phase 4, open a topic thread on one of researcher’s messages, and ask critic there to publish `notes/thread.md` with one line. Then delete only the topic thread, and ask researcher, in the conversation, to list the assets.

Pass if `notes/thread.md` is still listed: a topic thread shares its conversation’s assets, and deleting it alone erases none of them. Fail, and file it, if it’s gone.

## Phase 7: A restart after a purge

Local runs only. Restart Postbox (fault restart-postbox).

Pass if the load deleted the files of phase 1’s erased conversation, and the run’s records hold their `asset.released`; and the assets of the conversation from phase 4 still read back. Fail, and file it, if an erased conversation’s file is left, or a kept asset’s file is gone.
