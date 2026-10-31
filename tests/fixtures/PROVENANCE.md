# A2 Recorded Turn Fixtures Provenance (#508, DL-3, DL-8)

This directory records empirical evidence of agent turns that fail before any output, along with the immediate follow-up turn across confirmed backends (Claude Code, Antigravity CLI, and Codex app-server), satisfying requirements DL-3 and DL-8 for Phase 3 of the delivery design (`designs/508/design.md`, “Turn outcome”).

Per DL-8, Kiro is not a paid backend, so it is reported unverified.

---

## 1. Claude Code (`claude-haiku-5-5`)

### Environment & Commands

- **Binary:** Claude Code CLI (`claude` v2.1.37)
- **Fault launcher:** `tools/uat/fault-launcher.mjs`
- **Environment variables:**

  ```bash
  POSTBOX_CLAUDE_BIN="$PWD/tools/uat/fault-launcher.mjs"
  POSTBOX_UAT_REAL_BIN="claude"
  POSTBOX_CLAUDE_RECORD="$PWD/tests/fixtures/claude-code"
  POSTBOX_UAT_FAULT="fail-before-output researcher 1"
  POSTBOX_UAT_FAULT_STATE="/tmp/gemini508/fault-state-claude"
  ```

### Turn 1: Failure Before Output (`fail-before-output.jsonl`)

- **Session ID:** `f1d44fa9-3d78-4c31-a779-b56ccb50869a`
- **Prompt:** `@researcher What is the code name for the Apollo 11 mission? Answer in one short sentence.`
- **Interruption point:** Process sent `SIGKILL` by `fault-launcher.mjs` immediately upon the backend’s initial `{"type":"system","subtype":"init"}` session event.
- **Output:** Exactly 0 text deltas, 0 tool calls, 0 assistant messages.
- **Persistence outcome:** Because Claude Code was killed before flushing session files to disk, no local session file was persisted.

### Turn 2: Follow-up Turn (`resume-after-failure.jsonl`)

- **Follow-up prompt:** `@researcher Following up on the previous question: did you get it? Answer briefly.`
- **Session handling:** Postbox attempted to resume session `f1d44fa9-3d78-4c31-a779-b56ccb50869a`. Claude Code threw `No conversation found with session ID`. Postbox’s `missingSession` handler caught this error, reset `claudeSessionId`, and started a clean session (`f1d44fa9-3d78-4c31-a779-b56ccb50869a` allocated anew).
- **Transcript evidence:**
  - Claude’s thinking block:

    ```
    I can't see the earlier question, since the conversation history didn't load.
    I'll try read_conversation to see whether it shows the thread.
    ```
  - Claude invoked `mcp__postbox__read_conversation` (`{"limit": 20}`).
  - Postbox returned conversation items containing Turn 1’s prompt.
  - Claude answered:

    ```
    I didn't get an answer to the first question before, so I'm answering it now.
    The Apollo 11 lunar module was code-named "Eagle."
    ```

---

## 2. Antigravity CLI (`gemini-3.8-flash-low`)

### Environment & Commands

- **Binary:** Antigravity CLI (`agy`)
- **Fault launcher:** `tools/uat/fault-launcher.mjs`
- **Environment variables:**

  ```bash
  POSTBOX_AGY_BIN="$PWD/tools/uat/fault-launcher.mjs"
  POSTBOX_UAT_REAL_BIN="agy"
  POSTBOX_AGY_RECORD="$PWD/tests/fixtures/antigravity-cli"
  POSTBOX_UAT_FAULT="fail-before-output researcher 1"
  POSTBOX_UAT_FAULT_STATE="/tmp/gemini508/fault-state-agy"
  ```

### Turn 1: Failure Before Output (`fail-before-output.jsonl`)

- **Conversation ID:** `6baeb5b5-9944-4a9e-a1b6-26b69abcc7bd`
- **Prompt:** `@researcher What is the chemical formula for water? Answer in one word.`
- **Interruption point:** Process sent `SIGKILL` by `fault-launcher.mjs` immediately upon the backend’s initial `{"event":"init"}` session event.
- **Output:** Exactly 0 text deltas, 0 tool calls, 0 assistant messages.
- **Persistence outcome:** Antigravity CLI registers the conversation ID in workspace metadata at initialization.

### Turn 2: Follow-up Turn (`resume-after-failure.jsonl`)

- **Follow-up prompt:** `@researcher Following up: what question did I ask you? Answer briefly.`
- **Session handling:** Resumed with `agy -s 6baeb5b5-9944-4a9e-a1b6-26b69abcc7bd`.
- **Transcript evidence:**
  - Antigravity resumed session `6baeb5b5-9944-4a9e-a1b6-26b69abcc7bd`.
  - Invoked Postbox tool `call_mcp_tool` with `read_conversation`.
  - Read history item `[it_gsxoGwLY] You: @researcher What is the chemical formula for water? Answer in one word.`.
  - Answered: `You asked: “What is the chemical formula for water?”`.

---

## 3. Codex App-Server (`gpt-5.6-luna`)

Codex exhibits two distinct failure modes depending on whether failure occurs during thread initialization or after turn acceptance:

### Case A: Initialization Failure Before `turn/start` (`fail-before-output.jsonl`, `resume-after-failure.jsonl`)

- **Thread ID:** `01a18f8e-4ca6-7781-a96c-7e616ef9c0bc`
- **Prompt:** `@researcher What is the capital of France? Answer in one word.`
- **Interruption point:** Killed immediately after `thread/started`, before Postbox’s adapter dispatched `turn/start`.
- **Output:** Exactly 0 text deltas, 0 tool calls.
- **Persistence outcome:** Because zero turns completed or started, Codex app-server never committed a rollout file (`rollout-*.jsonl`).
- **Follow-up Turn:**
  - Postbox called `thread/resume` with thread ID `01a18f8e-4ca6-7781-a96c-7e616ef9c0bc`.
  - Codex responded with error code `-32600`: `no rollout found for thread id 01a18f8e-4ca6-7781-a96c-7e616ef9c0bc`.
  - Evidence: When an interrupted thread is killed prior to `turn/started`, no rollout file exists, and `thread/resume` rejects.

### Case B: Turn-Start Failure Before Output (`turn-fail-before-output.jsonl`, `resume-turn-after-failure.jsonl`)

- **Thread ID:** `01a18f94-af2c-7653-9e5d-4367a1881a9e`
- **Prompt:** `@researcher What is the capital of France? Answer in one word.`
- **Interruption point:** Interrupted immediately after `turn/started`, before any assistant output (no `item/agentMessage/delta`, no tool calls).
- **Output:** Exactly 0 text deltas, 0 tool calls.
- **Persistence outcome:** Because `turn/start` was accepted, Codex flushed a rollout record to disk marking the turn with `status: "interrupted"`, `items: []`.
- **Follow-up Turn:**
  - Follow-up prompt: `@researcher Following up: what question did I ask you? Answer briefly.`
  - Postbox called `thread/resume` with thread ID `01a18f94-af2c-7653-9e5d-4367a1881a9e`.
  - `thread/resume` succeeded! Codex hydrated the thread, reporting:

    ```json
    "turns": [{"id": "01a18f94-af4a-7eb0-a5d2-047e079fa18c", "status": "interrupted", "items": []}]
    ```
  - Because the interrupted turn had 0 output items, Codex retained no context of Turn 1’s prompt.
  - Codex answered: `"I don’t have your earlier question in this chat."`.
