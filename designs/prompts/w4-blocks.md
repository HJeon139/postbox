# Prompt: wave 4, blocks (#106, #180, #147, #137)

A wave 4 session, integrated by the triage session and reviewed by the reviewing session. Follow [README.md](README.md) for the rules every session shares. Your ports are 4700–4749 for servers and 9900–9949 for Chrome.

---

You’re fixing how blocks close and how they draw, on the branch `fix/w4-blocks`, in one pull request with one commit per issue.

## Why

- **#106 (P1):** a block that asks can’t be taken back. On 22 October 2026, @critic’s review block was approved and filed as #105. To note the link, @critic updated the block, which reopened the review, and the person approved it a second time “only because there was no other way to close it”. A question that’s wrong, handled or stale keeps its agent “needs you” until the person answers something they don’t mean.
- **#180:** an image Postbox serves itself is blocked by its own page policy when the page is opened at `localhost`. `img-src 'self'`, but the block’s URL is `127.0.0.1` (`server/index.mjs:569`). The block shows a broken image while its caption says “an allowed origin”. intent.md: “Nothing fails silently.” Found in the manual UAT of 23 October 2026.
- **#147:** display math written `$$…$$` on one line draws small and inline, between two stray dollar signs. That’s how agents usually write it (SciFact UAT, 23 October).
- **#137:** math in LaTeX’s own delimiters, `\( … \)` and `\[ … \]`, which GPT models on other backends write by default, shows as stray brackets around raw TeX.

## Read first

- [README.md](README.md); `designs/intent.md`, Dynamic UI (the block rows, #123’s revision rule and #92’s move-to-newest rule from #173); `designs/architecture.md` on blocks.
- Each issue with its comments.
- `update_block` and the answered-block paths in `server/runtime.mjs`, `shared/catalog.mjs`, `shared/markdown.mjs` (`MATH`, the inline parser) and `app/js/blocks.mjs`.

## The work

- **#106:**
  - An agent can withdraw a block it showed (an `update_block` that closes it with a reason), or amend one without asking again.
  - The person can dismiss a waiting block with a visible control, and the agent hears that it was dismissed.
  - A dismissed or withdrawn block reads as closed, with who closed it and why, and stops counting as needs-you. Clear `needs` through the existing paths (#69’s and #123’s).
  - **Don’t change how the overview or the sidebar draw needs-you.** The supervision session owns that.
- **#180:**
  - Treat both loopback spellings of Postbox’s own origin as one, in `img-src` and `sandbox.mjs`, or rewrite Postbox’s own media URLs to the page’s origin.
  - The image block handles `error`: it shows a line saying the image couldn’t load, in place of a broken image.
- **#147 and #137:**
  - `$$…$$` on one line is display math.
  - `\(…\)` and `\[…\]` are math, not escaped punctuation.
  - Outside math, a backslash escape keeps working.
  - Update the guide only if a limit or a rule changes.

## Files

- **Yours:** `shared/markdown.mjs`, `app/js/blocks.mjs`, `shared/catalog.mjs`, `update_block` and the block-answer paths in `server/runtime.mjs`, the CSP line in `server/index.mjs`, `server/sandbox.mjs`’s `img-src`, `tests/markdown.test.mjs` and the block tests.
- **Shared:**
  - **`server/runtime.mjs`:** the supervision session owns `needsYou` and the archive paths, and the side-threads session owns the side-thread code. Change only the block functions.
  - **#179** (the review block’s Preview / Lines and selection comments) is wave 5. Don’t start it here.

## Done when

- Each issue has a test that fails without its fix. #106 and #180 are covered in the page by a headless check, clean with `--lag 300`.
- At `localhost:<port>` and at `127.0.0.1:<port>`, the demo’s title-page image loads.
- The UAT docs for blocks and math say what changed (text only).
