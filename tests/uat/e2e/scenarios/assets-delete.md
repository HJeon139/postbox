# Assets and a deleted conversation: writes across a delete, and its erase

- persona: A team lead who wants a deleted conversation to stay deleted, with nothing of it still being written, and nothing of it seen from another. Writes short messages.
- agents: researcher, critic
- project: Login cleanup
- conversation: Deletes
- steps: 25

researcher and critic are in the room, on Claude Code, with the six asset tools (#516 S3). This is the acceptance run for #722, #723 and #724. Run it locally, then again with researcher on a host (`--host <host1> --place researcher=host1`), where phase 2 runs and phases 1 and 4 are skipped. The tester’s `conversation` action acts on the conversation that’s open: `{conversation: "delete", at?}`, where `at` is a time to wait for before deleting, `{conversation: "new", agents}` and `{conversation: "open", title}`, and as an interrupt during a turn, `{after, do: "conversation", conversation: "delete"}`. A local run can restart Postbox with `fault {fault: "restart-postbox"}`. A delete is immediate (#1224): there is no Undo. A phase that deletes a conversation deletes a second one it started, so this run’s own conversation, “Deletes”, survives. The checks `asset-content-in-store` and `asset-room-orphan` read every run’s records. Deleting a conversation stops every turn in it and erases it at once, so only a host whose link is down can reach the refusal for a deleted conversation (`no-conversation`). The edges no run can force are decided by tests: an erase between storing a write’s bytes and its commit (tests/asset-room-exists.test.mjs); content in other encodings (tests/asset-content-kept-out.test.mjs); and a topic thread deleted alone, which erases none of its conversation’s assets (tests/asset-failures.test.mjs, F11, “a topic alone erases none”). No person can delete a topic thread alone: Postbox refuses it with a 409, saying to delete the conversation it belongs to instead.

## Phase 1: Writes, then a delete

Local runs only; in the host run, skip it. Start a second conversation with researcher (`{conversation: "new", agents: ["researcher"]}`). Ask researcher, in one turn, to publish `notes/log.md` 20 times with `write_asset`, each from the version before and adding a line, running `sleep 1` in its folder between writes, and not to write the file in its folder instead. About 30 seconds in, after the first writes have published, delete that conversation (the interrupt `{after: 30, do: "conversation", conversation: "delete"}`). Then open “Deletes” again (`{conversation: "open", title: "Deletes"}`).

Unverified, not passed, unless the run’s records hold at least one `asset.version` for that conversation before its `asset.erase`: without one there is nothing for the delete to stop or erase. Pass if the turn stops at the delete, and the run’s records hold no `asset.version` after the conversation’s `asset.erase`; and `asset-room-orphan` finds nothing for it. Fail, and file it, if a version is published after the erase, or a room index or an asset is left for the deleted conversation.

## Phase 2: The host’s link down across the delete

The host run only; locally, skip it. Start a second conversation with researcher (`{conversation: "new", agents: ["researcher"]}`). Ask researcher, on host1, in one turn, to write `notes/host-log.md` 20 times with `sleep 1` between writes, quoting each answer. About 4 seconds in, kill its ssh connection (fault kill-ssh, target host1). While the link is down, delete that conversation (the interrupt `{after: 1, do: "conversation", conversation: "delete"}`), and open “Deletes” again (`{conversation: "open", title: "Deletes"}`).

Pass if any call that reaches Postbox after the reconnect is refused, saying the conversation was deleted, and its assets with it. Nothing is published after the erase. The run’s records decide whether a call arrived after the delete; if none did, say so: the phase is unverified, not failed, and tests/asset-room-exists.test.mjs decides the refusals. Fail, and file it, if a version is published after the erase, or a refusal points at `list_assets`.

## Phase 3: A second conversation can’t see them

In “Deletes”, ask researcher to publish `notes/keep.md` with one line, and to say the asset’s id. Then start a second conversation with researcher (`{conversation: "new", agents: ["researcher"]}`). Its researcher is a new session, with no record of that, so give it the id researcher said. Ask it to list the assets there, then to read the asset by that id. Then open “Deletes” again (`{conversation: "open", title: "Deletes"}`).

Pass if the list is empty, and the read is refused as not in this conversation. Fail, and file it, if any asset of “Deletes” is listed or read.

## Phase 4: A restart after an erase

Local runs only. Restart Postbox (`fault {fault: "restart-postbox"}`).

Unverified, not passed, unless phase 1 published at least one version before its erase: without one there are no files for the load to delete. Pass if the load deleted the files of phase 1’s erased conversation, and the run’s records hold their `asset.released`; and the assets of “Deletes” still read back. Fail, and file it, if an erased conversation’s file is left, or a kept asset’s file is gone.
