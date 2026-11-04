# Test fixtures

A fixture is a real turn, recorded, with local paths removed, and it’s never edited to make a test pass (designs/developing.md, “A fixture is a real turn, with local paths removed”). Every committed text file, fixtures included, passes the privacy check in `tools/privacy-check.mjs`, which `tests/process/privacy-tree.test.mjs` runs: no real home path or user id, no account data such as a rate limit’s utilization, no token, and no real email address.

## Synthetic fixtures

A fixture written by hand is a guess wearing a recording’s name, so until #508 closes one is allowed only when it’s listed here, with why it can’t be recorded. Where its format takes a comment line, its first line also says “SYNTHETIC” after the comment marker; a `.json` fixture can’t, so the listing alone marks it. The check fails when a listed file doesn’t exist, and when a fixture labelled synthetic isn’t listed. A hand-written fixture with no label and no listing looks like a recording to the check, so review has to catch that one.
- `tests/fixtures/delivery-routes/antigravity-pre-tool.jsonl`: the delivery spike’s protocol baseline for Antigravity, labelled not for receiver tests (tests/fixtures/delivery-routes.md). Why it wasn’t recorded isn’t written down yet.
- `tests/fixtures/delivery-routes/kiro-acp-stream.jsonl`: the same kind of baseline for Kiro’s ACP stream, with the same gap.
