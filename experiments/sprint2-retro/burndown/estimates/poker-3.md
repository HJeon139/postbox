# Estimation round 3 of sprint 2 (2 November 2026): #670

Same scale and references as `poker-1.md`.

The person’s decisions (block `d-browsers-scope`): a tagged subset of specs; Chromium on every PR, Firefox and WebKit nightly and on demand; a spec that fails on one engine is marked with its own issue, not fixed here; P0.

Facts: `playwright.config.mjs` on `main` has one project (`Desktop Chrome`, channel `chromium`). `.github/workflows/` has `check.yml`, `dependency-review.yml`, `prompt-surface-scan.yml` and `release.yml`; `git grep -E "schedule:|cron"` there finds nothing, so no nightly workflow exists yet.

Item:
- #670: Playwright projects for `firefox` and `webkit` that run a tagged subset (the shell, composer, blocks and the app sandbox); a nightly and on-demand CI workflow that installs both engines and runs them; Chromium on every PR unchanged; each spec in the subset that fails on an engine marked with its issue (filing those issues drafted first); `designs/engineering-practices.md`, “The gate”, and `tests/AGENTS.md` updated.

**Blind cards:** write `.scratch/sprint2/estimates-3-<your handle>.json` as before, without opening the others’ files, then post only “done” with its sha256.
