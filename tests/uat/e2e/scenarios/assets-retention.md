# Asset retention: large binaries pruned, text kept, and a delete’s Undo

- persona: An engineer who keeps model checkpoints and their notes as a conversation’s assets, wants old large files pruned but every note kept, and tries deleting a conversation by mistake to see what Undo saves. Writes short messages.
- agents: researcher
- project: Checkpoints
- conversation: Model files
- steps: 12

researcher is alone in the room, on Claude Code, with the six asset tools (#516 S3). Each phase confirms rows of #516’s S3 design: the person’s retention rule (text keeps every version; a large binary keeps its last few), the load pass, and what a delete’s Undo keeps. The rows no run can reach are listed in the README, “Assets”.

## Phase 1: Large binary versions are pruned

Ask researcher to make a 2 MB file of random bytes in its folder, `model.bin`, and publish it as an asset with `path`, then to replace the file and publish a new version the same way three more times, then to read version 1, and to restore version 1.

Pass if, after the fourth version, the read of version 1 says its bytes were pruned under the room’s retention rule, the restore of version 1 is refused because it was pruned, and versions 2 to 4 read as binary, with their size and type. Fail, and file it, if version 1 still reads as kept, or its restore makes a new version.

## Phase 2: Text keeps every version

Ask researcher to publish `notes/log.md` with one line, then four more versions, each adding a line, and then to read each of the five versions.

Pass if every version reads back with its own lines. Fail, and file it, if any text version is pruned.

## Phase 3: A restart, then the load pass

Restart Postbox (`fault {fault: "restart-postbox"}`, in a local run as in one with hosts). Then ask researcher to read version 1 of `model.bin` again.

Pass if it still says pruned, and the store’s log has one `asset.released` for its hash: the load pass deleted the released file once. Fail, and file it, if the read finds the bytes, or the file is released twice.

## Phase 4: A delete’s Undo keeps every asset

Deleting a conversation stops every agent in it, topic threads included, so no agent can be asked to write during the 10 seconds of Undo: only a write already in flight can meet it, and #688’s refusal for that case, `deleting`, is decided by the deterministic tests (tests/asset-room-exists.test.mjs, tests/asset-tools.test.mjs). This phase confirms the rest.

Delete the conversation and press Undo 3 seconds later (`{conversation: "delete", undo_after: 3}`). Then ask researcher to publish `notes/after-undo.md` with one line, and to list the assets.

Pass if the write publishes, and every asset from before the delete is still listed, with its versions. Fail, and file it, if anything is missing after Undo, or the write is refused.
