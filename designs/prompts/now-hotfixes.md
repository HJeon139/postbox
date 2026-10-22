# Prompt: implement the five “Now” hotfixes

A wave 1 session; [README.md](README.md) has the rules every wave session shares. Give this prompt to a new Claude Code session in `/Users/hohyunjeon/postbox`, in its own worktree. It implements the hotfix milestone of the plan ([#64](https://github.com/HJeon139/postbox/issues/64)) as one pull request, then hands it to the reviewing session, which runs the end-to-end UAT.

---

You’re implementing the five hotfixes in Postbox’s “Now: hotfixes” milestone, as one pull request with one commit per fix. Use subagents for the work and for an adversarial review. Then validate the code against the repo’s engineering practices, and hand the pull request to the reviewing session. **Don’t run the end-to-end UAT (`tools/uat-run.mjs`, `npm run uat`).** The reviewing session runs it on your pull request.

## Read first

1. `designs/engineering-practices.md`: the rules every change is held to, and the gate. Everything below assumes it.
2. `designs/architecture.md`, sections 5 (real agents), 6 (permissions), 9 (topic threads) and the sandbox section; and `designs/intent.md` for the interface rules. In particular: nothing hover-only, amber is the only interaction color, design tokens only.
3. Each issue, with its comments, which hold the triage and the decisions: `gh issue view <n> --repo HJeon139/postbox --comments` for #61, #57, #38, #45 and #48.

## The five fixes

Commit them in this order, one commit each, with `Fixes #n` on its own line in the message.

### 1. #61: topic-thread forks fail every turn, and the error is hidden (P0)

**Symptom.** A topic thread forks with `--resume <parent> --fork-session --resume-session-at <uuid>`. When the checkpoint uuid is no longer on the parent’s chain, Claude Code fails with `error_during_execution` and `errors: ["No message found with message.uuid of: …"]`. Postbox shows only “hit an error while running the turn”, and every retry fails the same way.

**Fix:**
- `resultError` in `server/adapters/claude-stream.mjs` appends `result.errors`.
- Add `forkPointMissing(result)`.
- In both adapters: when a fork with a uuid fails that way, save the fork without the uuid and run once more from the parent’s latest point. Start the prompt with a short note that the thread couldn’t start at the message it branched from. The SDK adapter also clears `sdkSessionId`.

**Before you write it,** check whether the reporter pushed this fix (`gh pr list`, `git ls-remote origin`). If they did, review it and build on it.

**Tests:**
- Reproduce the error by hand with a bogus `--resume-session-at` uuid. It’s one cheap CLI call; record its result line as a fixture.
- Test both adapters’ fallback with a fake spawn and a fake SDK.
- Test the error text.

### 2. #57: personas inherit the person’s Claude Code settings (P0)

**The decision (final; see the issue’s last comment).** Personas load the person’s Claude Code setup by default (user, project and local settings: skills, slash commands, plugins, MCP servers, permission rules), with two overrides:
- **The output style** is forced to the default.
- **Tools that publish outside Postbox are denied** unless the persona allows them: artifacts, and connectors that post or send.

A persona can also switch to **Isolated**, which loads project settings only.

**Fix:**
- Pass `--setting-sources` explicitly in `claudeArgs` (`user,project,local`, or `project` when Isolated). Override the output style with `--settings` (find the exact key in the settings docs or `claude --help`; don’t guess it). Deny the outside-publishing tools with `--disallowedTools`.
- Do the same in `sdkOptions`: `settingSources`, the `settings` overlay, and `disallowedTools`.
- Find the real names of the publishing tools first. Record one real turn with your own setup (`POSTBOX_CLAUDE_RECORD=<folder>`) and read the `init` event’s `tools`, `mcp_servers` and `output_style`. Build the deny list from what’s there (built-in artifact tools, MCP connector tools whose names post or send), not from memory, and keep it in one place with a comment saying how it was derived.
- In the persona sheet (`app/js/sheets.mjs`, under the real backends’ fields), add two visible controls:
  - “Uses your Claude Code setup” (on by default; off means Isolated).
  - “Can publish outside Postbox” (off by default).

  Store them on the persona, and validate them in `createPersona` and `updatePersona`.
- Update the UAT check `settings-leak` in `tools/uat/checks.mjs`, and its test, to match. With this decision, the person’s global CLAUDE.md reaching agents is intended. The check should flag:
  - an `init` `output_style` other than the default
  - the person’s output style reminders in transcripts
  - publishing tools present in `init.tools` for a persona that doesn’t allow them

**Tests:** `claudeArgs` and `sdkOptions` for each combination; persona validation.

### 3. #38: apps can send events in the person’s voice with no click (P0)

**The decision:** an app’s `postbox.send` is accepted only after a click or key press in that app, at most a few per minute. Past the limit, a card asks the person to approve the batch.

**Fix:**
- **In the host** (`app/js/apps.mjs`, the bridge’s `event` case), track user activation per app frame. When the window blurs and `document.activeElement` is that app’s iframe, the person clicked or tabbed into it. Record the time, and accept sends for a short window after it. The frame can’t fake this: its own claims about activation aren’t trusted.
- Reject a send without recent activation, with a clear error the app receives.
- Rate-limit per app, in the host and on the server (`/api/apps/:id/event` in `server/index.mjs` and the runtime), so a script calling the API is held to the same limit.
- Past the limit, queue the events and show a Postbox card in the conversation: “<app> wants to send N messages for you”, with Allow and Don’t allow. Keep events off during the pre-display check, as now.

**Tests:**
- The runtime: the limit, the card, and approving or declining it.
- A headless Chrome check (`tools/cdp.mjs`) that an app sending on load is refused, and one sending after a real click is accepted.

### 4. #45: an app’s full-screen button only makes it taller (P1)

**Fix:** make it a real full-screen view.
- An overlay at the window’s size. Give the overlay element the class `fullscreen` and keep the app’s `.appframe` inside it; the UAT driver looks for that.
- The frame resizes to fill it.
- Close with Escape and with a visible button.
- Move focus into the overlay, and return it to the button on close.
- The button’s `aria-label` is “Full screen” or “Exit full screen”, and it keeps its icon.

Keep one control. Lifting the height cap in the column can stay as part of it, or go, but there aren’t two buttons. Saved state and the version menu keep working, and no second copy of the app runs.

**Tests:** a headless check that the frame fills at least 90% of the window, and that Escape restores it. Update the text of `tests/uat/conversation/agent-apps/app-frame.md`.

### 5. #48: image attachments show as file chips, and drag and drop misses the thread panels (P1)

**Fix:**
- `attChip()` in `app/js/thread.mjs` shows a thumbnail for images the server serves inline (`INLINE_TYPES` in `server/index.mjs`; that route is already sandboxed and `nosniff`), with the name and size, and opens the full image.
- Each side and topic composer gets its own drop target that stops propagation, so a drop attaches to the composer it lands on.

**Tests:** a headless check for each. Update `tests/uat/conversation/composer/composer.md`.

## How to work

1. **Set up.** Create the branch `fix/now-hotfixes` from `main`. Run `npm ci`, then `npm run check`, so you know the baseline is green.
2. **Implement with three subagents in parallel,** each in its own worktree (`isolation: "worktree"`). The groups don’t share files:
   - **Adapters:** #61, then #57. Owns `server/adapters/*`, the persona fields in `server/runtime.mjs` and `app/js/sheets.mjs`, and `tools/uat/checks.mjs`.
   - **Apps:** #38, then #45. Owns `app/js/apps.mjs`, the app event path in `server/index.mjs` and `server/runtime.mjs`, `app/kit/kit.js`, and the app CSS.
   - **Composer:** #48. Owns the composer and attachment code in `app/js/thread.mjs`, and its CSS.

   Give each subagent:
   - its issues
   - the decisions above
   - the practices doc
   - the files it owns, and which files it must not touch
   - the rule that its work isn’t done until `npm run check` passes in its worktree, with a test for each fix that fails without it

   Each returns one commit per fix.
3. **Integrate.** Cherry-pick the commits onto `fix/now-hotfixes` in the order above. Run `npm run check` after each, and resolve any conflict yourself.
4. **Review adversarially.** Start a review subagent with the full diff (`git diff main...fix/now-hotfixes`) and `designs/engineering-practices.md`. Ask it to find violations of every section, and bugs: edge cases, races, security, accessibility. Every finding needs a file, a line and a concrete failing scenario. Fix what it confirms, in the commit it belongs to (`git commit --fixup`, then `git rebase --autosquash`), and say in the pull request what you declined and why.
5. **Validate.** `npm run check` and each fix’s headless checks must pass. Update the text of the UAT docs your fixes affect, but don’t refresh their screenshots. **Don’t run** `tools/shoot-app.mjs` or `tools/shoot-uat.mjs`: the reviewing session runs them, with axe, on the merged wave (see `designs/prompts/README.md`).

   Go through the practices doc section by section, and note in the pull request how the change meets each one, or why one doesn’t apply.
6. **Push and open the pull request.** Push `fix/now-hotfixes` and open a pull request against `main` with `gh pr create`. **Don’t merge it.**

   The body has, for each fix:
   - what changed
   - how it was tested
   - its evidence (test names, headless results, screenshots)
   - anything left for later

   Then the practices checklist and the review subagent’s findings. End the body with:

   🤖 Generated with [Claude Code](https://claude.com/claude-code)

   End each commit message with:

   Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
7. **Hand off for review.** When the pull request is open and every check above passes, message the reviewing session with `SendMessage`: it’s listed by `ListAgents` as “Agentic chat room web app” (session id `local_48b46372-79f5-4077-82d6-946342d2f22e`). Include:
   - the pull request’s URL and head commit
   - one line per fix on how it was verified
   - anything you want the UAT to look at in particular

   That session runs the end-to-end UAT on the branch and replies with what it found. Fix what it reports on the same branch, and message it again. If `SendMessage` can’t reach it, comment on the pull request: “Ready for UAT review.”

## Rules

- Never handle credentials. Real agent turns use the person’s own signed-in `claude`. Keep real turns to the few needed to record fixtures for #57 and #61, on a short prompt.
- Don’t touch `data/`, the preview server on port 4173, or anything on port 4320 (another tool runs there). Use ports 4400 to 4499 for servers and 9600 to 9699 for Chrome.
- Don’t push to `main`, and don’t merge.
- Write all copy and docs in American English, with curly quotes, in sentence case. Draw diagrams in Mermaid.
- When something in this prompt turns out to be wrong (a file name, a flag, a field), check the code or the docs, follow what’s true, and say so in the pull request.
