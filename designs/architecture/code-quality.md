# Code quality: linters and checks

Part of [the architecture](../architecture.md).

**Decision.** These run locally (`npm run check`) and in continuous integration on every pull request, except the two marked CI only, which are GitHub services. Every other tool is a development dependency, pinned in a lockfile and never shipped.

| Check | Tool | What it enforces |
|---|---|---|
| Lint and format | **Biome** (one dependency, no plugins) | Recommended correctness and suspicious-code rules, consistent formatting, no unused code, and a length limit on every file and function (“Module and function size”, below) |
| Types | **TypeScript in `checkJs` mode** with JSDoc types, `noEmit` | Shapes of events, blocks and store state checked without a build. It starts with `shared/` and `server/`, then the client. |
| Tests | `node:test` with `--experimental-test-coverage` | Pure modules (catalog, Markdown, events, BM25, store) stay above 90% line coverage |
| End to end | **Playwright Test** (`tests/browser/`), with **axe-core** in `tests/browser/demo-a11y.spec.mjs` | Every demo scene renders with no exceptions and no accessibility violations against WCAG 2.1 A and AA, at 1280 and 375 px in both themes |
| Contrast | `tools/contrast.mjs` | Every token pair meets WCAG 2.1 AA in both modes, on the app stage too |
| Design tokens | `tools/lint-tokens.mjs` | No raw colors outside the token blocks, in CSS or in JavaScript |
| Safe DOM | `tools/lint-dom.mjs` | `innerHTML` only where a `lint-allow dom:` comment names the source (the Markdown renderer or Postbox’s own templates); no attribute or style names chosen at run time; `target="_blank"` always with `noopener` |
| Security rules | `tools/lint-security.mjs` | Flags a regular expression built from anything but constants or `escapeRegExp()`; a one-pass tag strip outside `stripTags()`; a `JSON.stringify` splice in a browser check's page code, where `js()` belongs; a `===` or `!==` comparison of a name ending in “token”, where `sameToken()` belongs; and git run outside `runGit()` (SECURITY.md) |
| Copy | `tools/lint-copy.mjs` | American spelling and curly quotes in user-facing strings |
| Length ceilings | `tools/lint-caps.mjs` | No change loosens a length limit: `biome.json` is compared with the base and fails closed, a new override stays at or under the default, and a nested Biome config or a suppression that covers a length rule fails (“Module and function size”, below) |
| Code scanning | **CodeQL**, GitHub’s default setup (CI only) | No pull request adds a high or critical security alert, or a CodeQL error: the `protect-main` ruleset requires its results |
| Dependencies | `actions/dependency-review-action` (CI only, `.github/workflows/dependency-review.yml`) | No pull request adds or changes a dependency, shipped or development, with a known vulnerability of moderate severity or worse |
| Prompt scan | `tools/prompt-surface.mjs` and **SkillSpector**, static rules (CI only, `prompt-surface-scan.yml`) | The rendered prompt diff is in the job summary for the reviewer, and a pull request that adds a high or critical SkillSpector finding fails it (“Prompt changes are reviewed as rendered text”, below) |

**Conventions**
- An `.editorconfig` sets 2-space indentation, LF line endings and UTF-8.
- Commits are small, with sentence-case subjects.
- Every user-facing string follows the writing rules in [intent.md](../intent.md).
- No runtime dependencies without a decision recorded here.

**Exceptions.** A deliberate exception to a project rule carries `lint-allow <rule>: <reason>` on its line or the line above, and a whole file can opt out of one rule with `lint-allow-file <rule>: <reason>` near its top. A reason is required, so every exception says why. `lint-ternary` is the one lint that takes only the line-level form: `lint-allow ternary: <reason>` on the line it names or the line above. It refuses `lint-allow-file ternary`, so a file past its ceiling can’t opt out of the rule as a whole, and its failure says so (#753).

**Where it stands (Stage 3).** Everything in the table runs, locally and in CI:
- TypeScript runs in strict mode over `shared/` and `server/`; the client comes next.
- axe-core found 92 violations on its first run, all fixed: radios that said pressed instead of checked, labels on elements with no role, a button whose name didn’t match its text, and dim text on the review highlight in dark mode. The contrast tool now checks translucent tokens too, which is how the last one was missed.
- Coverage is 89% of lines overall. Of the pure modules, `state.mjs` (88%) is still below the 90% target.

**Revisit when** a tool becomes a bottleneck. Biome and TypeScript are the only tools here that a contributor has to install.
