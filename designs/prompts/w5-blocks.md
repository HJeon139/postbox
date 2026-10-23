# Prompt: wave 5, blocks and text (#106, #180, #147, #137, #196, #216)

A wave 5 session, carried over from wave 4, where it never started, with #196 and #216’s message added. The triage session integrates it, and the architectural review session reviews it. Follow [README.md](README.md) for the rules every session shares. Your ports are 4700–4749 for servers and 9900–9949 for Chrome.

---

You’re fixing how blocks close, how blocks and math draw, and how a reply is read aloud, on the branch `fix/w5-blocks`, in one pull request. The first commit moves the block functions out of `server/runtime.mjs` (README.md, “Length limits”), then one commit per issue.

## Why

- **#106 (P1):** a block that asks can’t be taken back. On 22 October 2026, @critic’s review block was approved and filed as #105. To note the link, @critic updated the block, which reopened the review, and the person approved it a second time “only because there was no other way to close it”. A question that’s wrong, handled or stale keeps its agent “needs you” until the person answers something they don’t mean.
- **#180:** an image Postbox serves itself is blocked by its own page policy when the page is opened at `localhost`. `img-src 'self'`, but the block’s URL is `127.0.0.1` (`server/index.mjs:569`). The block shows a broken image while its caption says “an allowed origin”. intent.md: “Nothing fails silently.” Found in the manual UAT of 23 October 2026.
- **#147:** display math written `$$…$$` on one line draws small and inline, between two stray dollar signs. That’s how agents usually write it (SciFact UAT, 23 October).
- **#216, the defect part:** a topic thread’s agent that calls `update_block` on a block its parent session showed in the conversation is told “There’s no block with id … Use show_block to add it.” So it posted a second copy and asked the person to ignore the first (HotpotQA UAT, 23 October 2026). Whether a fork may change its parent’s block is a decision shared with #210. Until then, the answer says the block is in the conversation, and what the agent can do from the thread.
- **#196:** a screen reader hears each reply through the live region as raw Markdown, and loses everything before a dot inside a word: `**`converter.py`**: …` is read as “py\`\*\*: …”. `finishedSentences` (`shared/text.mjs:30`) can’t cross a dot, and its lookahead rejects one followed by a letter (manual UAT, 23 October 2026). intent.md, principle 5: every value is also available as text.
- **#137:** math in LaTeX’s own delimiters, `\( … \)` and `\[ … \]`, which GPT models on other backends write by default, shows as stray brackets around raw TeX.

## Read first

- [README.md](README.md); `designs/intent.md`, Dynamic UI (the block rows, #123’s revision rule and #92’s move-to-newest rule from #173); `designs/architecture.md` on blocks.
- Each issue with its comments.
- `update_block` and the answered-block paths in `server/runtime.mjs`, `shared/catalog.mjs`, `shared/markdown.mjs` (`MATH`, the inline parser) and `app/js/blocks.mjs`.
- `finishedSentences` in `shared/text.mjs`, and `announceStreaming` in `app/js/ui.mjs`.
- `designs/architecture.md`, “Module and function size”, and README.md, “Length limits”.

## The work

- **First, the move:** move `update_block`’s handling and the block-answer functions (`act`, `answerDelivered`, `unreadAnswer`) out of `server/runtime.mjs` into `server/blocks.mjs`, by the rewrite README.md’s “Length limits” allows, with their ceilings. Nothing else changes in that commit. `act`, `answerDelivered` and `unreadAnswer` are one run of methods. `update_block` is a closure inside `toolsFor` that reads `sessionId`, `turn`, `threadId()`, `se()` and `endSegment`. Move it as a function that takes those as parameters, as `askForTool(rt, sessionId, args, endSegment, threadId())` does, leave a one-line call in `toolsFor`, and name the parameters in the commit message. The module-level helpers they read move with them, or go to a module both files import: `update_block` uses `OUTCOME_LATER` and `stampSteps`, and `act` uses `clipText` and `CATCH_UP_CHARS`.
- **#106:**
  - An agent can withdraw a block it showed (an `update_block` that closes it with a reason), or amend one without asking again.
  - The person can dismiss a waiting block with a visible control, and the agent hears that it was dismissed.
  - A dismissed or withdrawn block reads as closed, with who closed it and why, and stops counting as needs-you. Clear `needs` through the existing paths (#69’s and #123’s).
  - **Don’t change how the overview or the sidebar draw needs-you.** #190 settled that.
- **#180:**
  - Treat both loopback spellings of Postbox’s own origin as one, in `img-src` and `sandbox.mjs`, or rewrite Postbox’s own media URLs to the page’s origin.
  - The image block handles `error`: it shows a line saying the image couldn’t load, in place of a broken image.
- **#147 and #137:**
  - `$$…$$` on one line is display math.
  - `\(…\)` and `\[…\]` are math, not escaped punctuation.
  - Outside math, a backslash escape keeps working.
  - Update the guide only if a limit or a rule changes.
- **#216:** a block the caller’s parent session showed gets an answer that says so, and offers what the agent can do from the thread: show a corrected block there, or ask the person to send it to the conversation. A block no session showed still gets today’s answer.
- **#196:**
  - A sentence ends only at `.`, `!` or `?` followed by whitespace or the end of the text, so `converter.py`, `README.md`, `6.21371`, `v0.13.0` and “e.g.” stay inside their sentence and nothing is dropped.
  - The live region gets plain text: no code ticks, emphasis marks, heading marks or list bullets, and a link’s text without its URL. Use what the Markdown renderer draws if it can give it.
  - A streaming reply still announces each sentence once, when it’s finished.

## Files

- **Yours:** `shared/markdown.mjs`, `shared/text.mjs`, `announceStreaming` in `app/js/ui.mjs`, `app/js/blocks.mjs`, `shared/catalog.mjs`, `server/blocks.mjs` and the lines in `server/runtime.mjs` that call it, the CSP line in `server/index.mjs`, `server/sandbox.mjs`’s `img-src`, `tests/markdown.test.mjs` and the block tests.
- **Shared:**
  - **`server/runtime.mjs` and `biome.json`:** every wave 5 session moves its own concern out first. Move only the block functions. Add a `biome.json` entry only for your new module, and leave `runtime.mjs`’s override to the integrator (README.md, “Length limits”).
  - **`server/mcp.mjs`:** the apps session adds `retire_app`. Change only the block tools’ definitions.
  - **#179** (the review block’s Preview / Lines and selection comments) is wave 5. Don’t start it here.

## Done when

- Each issue has a test that fails without its fix. #106 and #180 are covered in the page by a headless check, clean with `--lag 300`. #196’s test covers the five spellings above.
- At `localhost:<port>` and at `127.0.0.1:<port>`, the demo’s title-page image loads.
- The UAT docs for blocks and math say what changed (text only).
