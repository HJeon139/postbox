# Codex conformance recordings

What codex-cli saved and sent in the backend conformance probe’s runs (#585, tools/AGENTS.md, “Backend conformance”). They aren’t app-server streams, so they live apart from `tests/fixtures/codex-app-server/`, whose streams the replay tests read. The rules every fixture follows are in `tests/fixtures/README.md`.

Both were recorded by the probe itself, with codex-cli 0.167.0, on 28 November 2026 (UTC):

```bash
node tools/backend-conformance.mjs codex --record tests/fixtures/codex-conformance
```

Record them again the same way when Codex’s version changes. The probe runs Codex with a temp HOME and CODEX_HOME, an environment of PATH, HOME, CODEX_HOME and a placeholder alone, no sign-in, and no real model: its turns go to a fake Responses endpoint on 127.0.0.1. It opens every thread through the adapter’s own `openCodexThread`, with the guide `agentGuide` builds for a persona whose instructions hold a marker of the run’s own (`postbox-conformance-start-…`). The tests read that marker, and the guide around it, back from each file.

## What’s kept

`tools/conformance/record.mjs` keeps an allowlist, and nothing outside it:
- **Kept:** each rollout line’s type, in order; each message item’s type, role and parts, in order; the texts the probe wrote, which are the guide, whole, and its own message; Codex’s version; and each request’s model.
- **Cut:** every other text, Codex’s own instructions, skills, permissions and environment context among them, becomes “[cut: N characters of Codex’s own text]”.
- **Left out:** ids, folders, timestamps, tools, cache keys, metadata, and every field the allowlist doesn’t name. Any item other than a message keeps its type alone.

## `guide-rollout.jsonl`

The thread’s rollout under `$CODEX_HOME/sessions`, after `thread/start` and `thread/inject_items`, then a resume in a new process and another injected item. `tests/conformance-rollout.test.mjs` counts the guide in it.

## `guide-request.json`

The body Codex sent the fake for the turn after `thread/start`. `tests/conformance-fake.test.mjs` counts the guide in it.
