# A2 recorded turn fixtures (#508, DL-3, DL-8)

This directory records empirical baseline fixtures of agent turns that fail before any output, along with the immediate follow-up turn across confirmed backends (Claude Code, Antigravity CLI, and Codex app-server).

These recordings document the baseline behavior on `main`, not a contract: on every backend on `main`, a message from a turn that failed before output reached neither the backend's history nor the next turn's prompt. That is DL-3 failing on `main`, which is what A2 fixes. The recordings serve as replay inputs to verify that mappers report no text and no activity on a failed turn, allowing A2 to detect "failed before output" and re-inject the unacknowledged message on resume.

---

## File hashes

| File | SHA-256 |
|---|---|
| `tests/fixtures/antigravity-cli/fail-before-output.jsonl` | `7287fb3bf213d106bf943acf9eca8b290d2b6a80a45c2a65b4871180e1bf0607` |
| `tests/fixtures/antigravity-cli/resume-after-failure.jsonl` | `876b80993f40536d72acafb862223f6b185fd257ac9c10d358f9ccb286ec4122` |
| `tests/fixtures/claude-code/fail-before-output.jsonl` | `d2ab22472d1ceb891b9e2711446d96f92a616e3b65af3616ab9456998cc67df6` |
| `tests/fixtures/claude-code/resume-after-failure.jsonl` | `699f0c6be2b0e359a82e7cb32410b147e5306190cfb8fc00a143e78fcba3d6f0` |
| `tests/fixtures/codex-app-server/fail-before-output.jsonl` | `f6bd046aa0c5cec214fe8323b93f45df715ea216d78c55c711acd96af060e058` |
| `tests/fixtures/codex-app-server/resume-after-failure.jsonl` | `6718a25277fc537e275b0020b9c84446baae14ecfe3d43a9eb156792572d9de6` |
| `tests/fixtures/codex-app-server/turn-fail-before-output.jsonl` | `01e5bbd4d48aebb50c4f9ab434338feb2e71b5c99722ec4bc5f42e77b11872bc` |
| `tests/fixtures/codex-app-server/resume-turn-after-failure.jsonl` | `5a6e1a8b0b07ec2e67d4251c0a0fea2e9bdf7a3415aff5b460f48d67067db64b` |

---

## Coverage and gaps against DL-8

- **Claude Code:** Recorded (`claude-haiku-5-5`).
- **Antigravity CLI:** Recorded (`gemini-3.8-flash-low`).
- **Codex app-server:** Recorded (`gpt-5.6-luna`), covering both pre-turn-start kill and post-turn-start kill.
- **Agent SDK:** Covered by the Claude Code fixtures, because `AgentSdkAdapter` uses the same `createStreamMapper` stream parsing pipeline.
- **Kiro CLI:** Unverified. Live runs were bounded under the person-set budget cap of $25 per UAT run, and Kiro CLI was not installed locally. Missing recordings are tracked for when Kiro tooling is configured.
- **Not covered:** Remote turns (turns running on remote hosts via the host daemon transport).

---

## 1. Claude Code (`claude-haiku-5-5`)

### Environment and commands

- **Binary:** Claude Code CLI (`claude` v2.1.296)
- **Fault launcher:** `tools/uat/fault-launcher.mjs`
- **Environment variables:**

  ```bash
  POSTBOX_CLAUDE_BIN="$PWD/tools/uat/fault-launcher.mjs"
  POSTBOX_UAT_REAL_BIN="claude"
  POSTBOX_CLAUDE_RECORD="$PWD/tests/fixtures/claude-code"
  POSTBOX_UAT_FAULT="fail-before-output researcher 1"
  POSTBOX_UAT_FAULT_STATE="/tmp/postbox-fault/fault-state-claude"
  ```

### Turn 1: failure before output (`fail-before-output.jsonl`)

- **Session ID:** `f462ecda-6ba4-4cb7-ae8a-093d9ec2167c`
- **Prompt:** `@researcher What is the code name for the Apollo 11 mission? Answer in one short sentence.`
- **Interruption point:** Sent `SIGKILL` by `fault-launcher.mjs` immediately upon the backend’s initial `{"type":"system","subtype":"init"}` session event.
- **Output:** Exactly 0 text deltas, 0 tool calls, 0 assistant messages.
- **Persistence observation:** Process was killed before Claude Code persisted a session file for `f462ecda-6ba4-4cb7-ae8a-093d9ec2167c` to disk.

### Session transition and turn 2 (`resume-after-failure.jsonl`)

- **Baseline behavior on `main` before A2:** Postbox attempted to resume session `f462ecda-6ba4-4cb7-ae8a-093d9ec2167c` with `--resume`. Claude Code exited with `No conversation found with session ID`. Postbox’s `missingSession` handler cleared `claudeSessionId` and initiated a fresh session (`f1d44fa9-3d78-4c31-a779-b56ccb50869a`).
- **Follow-up prompt:** `@researcher Following up on the previous question: did you get it? Answer briefly.`
- **Observations:** The unacknowledged prompt was absent from the fresh turn's prompt. The model recovered only by autonomously invoking `read_conversation`.

---

## 2. Antigravity CLI (`gemini-3.8-flash-low`)

### Environment and commands

- **Binary:** Antigravity CLI (`agy`)
- **Fault launcher:** `tools/uat/fault-launcher.mjs`
- **Environment variables:**

  ```bash
  POSTBOX_AGY_BIN="$PWD/tools/uat/fault-launcher.mjs"
  POSTBOX_UAT_REAL_BIN="agy"
  POSTBOX_AGY_RECORD="$PWD/tests/fixtures/antigravity-cli"
  POSTBOX_UAT_FAULT="fail-before-output researcher 1"
  POSTBOX_UAT_FAULT_STATE="/tmp/postbox-fault/fault-state-agy"
  ```

### Turn 1: failure before output (`fail-before-output.jsonl`)

- **Conversation ID:** `6baeb5b5-9944-4a9e-a1b6-26b69abcc7bd`
- **Prompt:** `@researcher What is the chemical formula for water? Answer in one word.`
- **Interruption point:** Sent `SIGKILL` by `fault-launcher.mjs` immediately upon the backend’s initial `{"event":"init"}` session event.
- **Output:** Exactly 0 text deltas, 0 tool calls, 0 assistant messages.
- **Persistence observation:** The conversation ID is registered in workspace metadata at initialization.

### Session transition and turn 2 (`resume-after-failure.jsonl`)

- **Baseline behavior on `main` before A2:** Resumed with `agy -s 6baeb5b5-9944-4a9e-a1b6-26b69abcc7bd`.
- **Follow-up prompt:** `@researcher Following up: what question did I ask you? Answer briefly.`
- **Observations:** The unacknowledged prompt did not reach the model's history. The model recovered only by autonomously calling `call_mcp_tool` with `read_conversation`.

---

## 3. Codex app-server (`gpt-5.6-luna`)

Note: Host identities (`serverName`) and installation UUIDs (`installationId`) in raw records are replaced with placeholders (`placeholder.localdomain` and `00000000-0000-0000-0000-000000000000`).

### Case a: initialization failure before `turn/start` (`fail-before-output.jsonl`, `resume-after-failure.jsonl`)

- **Thread ID:** `01a18f8b-1402-74a1-a151-15688f158b06`
- **Prompt:** `@researcher What is the capital of France? Answer in one word.`
- **Interruption point:** Interrupted immediately after `thread/started`, before Postbox’s adapter dispatched `turn/start`.
- **Output:** Exactly 0 text deltas, 0 tool calls (`item/*`).
- **Baseline behavior on `main` before A2 (#587):**
  - Postbox called `thread/resume` with thread ID `01a18f8b-1402-74a1-a151-15688f158b06`.
  - Codex responded with error code `-32600`: `no rollout found for thread id 01a18f8b-1402-74a1-a151-15688f158b06`.
  - Because `codex.mjs` on `main` saved the thread ID before `turn/start` and had no missing-session fallback, subsequent turns failed permanently (#587).

### Case b: turn-start failure before output (`turn-fail-before-output.jsonl`, `resume-turn-after-failure.jsonl`)

- **Thread ID:** `01a18f94-af2c-7653-9e5d-4367a1881a9e`
- **Prompt:** `@researcher What is the capital of France? Answer in one word.`
- **Interruption point:** Interrupted immediately after `turn/started`, before any assistant output (no `item/agentMessage/delta`, no tool calls).
- **Output:** Exactly 0 text deltas, 0 tool calls (`item/*`).
- **Baseline behavior on `main` before A2:**
  - Follow-up prompt: `@researcher Following up: what question did I ask you? Answer briefly.`
  - Postbox called `thread/resume` with thread ID `01a18f94-af2c-7653-9e5d-4367a1881a9e`.
  - `thread/resume` succeeded, but the interrupted turn had an empty items list (`"items": []`).
  - The person's prompt was not present in Codex's conversation history, and Codex did not call `read_conversation`.
