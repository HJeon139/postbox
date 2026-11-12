# Diagram legibility: estimate, then measure

Part of [the architecture](../architecture.md).

**Decision.** Two checks find Mermaid diagrams too small to read, and both reach the agent as a `lint` message that says what to change. Each diagram is reported once.
- **The estimate** ([`shared/diagram-lint.mjs`](../../shared/diagram-lint.mjs)) runs on each finished reply. It reads the Mermaid source well enough to estimate the layout’s width, and from that the size its text ends up at in the 728 px column. It also flags too many boxes, one row of many boxes, and long sequences.
- **The measurement** happens in the browser after a diagram renders: its text size is 13 px × the scale it was drawn at. Anything under 10 px at the conversation’s width is reported to the server, unless the estimate already caught it.

**What it rests on**
- **It’s the symptom people see.** A wide diagram doesn’t fail; it shrinks. Text size is the measure that matches what a reader experiences, so both checks use it.
- **Fitted, not guessed.** The estimate’s layout constants (8.5 px per character, about 56 px of padding per box, the gaps between sequence participants) were fitted to diagrams rendered in Chrome. They agree to within about half a pixel, and the measured values are a test.
- **Prevention first, by drawing instead.** The agent guide steers a picture that explains away from Mermaid: it asks agents to draw what things are or do in an app, not labeled boxes, and keeps Mermaid for a quick sketch. The maintainer’s blind verdicts on 20 agent-made visuals failed every diagram of labeled boxes, a well-made Mermaid flowchart included ([#206](https://github.com/HJeon139/postbox/issues/206)). The guide used to ask for about five boxes side by side and top-to-bottom chains; for the Mermaid diagrams agents still write, these two checks now carry that advice, in the lint message that says what to change.
- **No loops.** A reply to a lint message isn’t linted again by either check.
- **One pipeline for every check.** Each check returns problems, `{ code, message, scope }` ([`server/checks.mjs`](../../server/checks.mjs)). The runtime gathers the problems one agent turn caused into one lint turn: the server’s checks run when the turn ends, and what the browser reports (a diagram measured or failing to draw, the app check’s warnings) joins them within a moment of rendering. A turn gets at most one lint turn, and a lint turn that only calls tools, such as `define_term`, shows as a one-line note rather than a reply.
- **A reply that should have been a block** ([#63](https://github.com/HJeon139/postbox/issues/63)). Agents drift back to prose over a long session, so every reply is checked for how it ends: options in a list with a question or “pick one”, three or more questions, a draft of 40 lines or more that asks for sign-off, or a Markdown table of ten rows or more. A turn that showed the matching block, or followed a request for Markdown or prose, isn’t flagged. Each finding costs a lint turn, so the check is conservative; its lint turn asks for the block and needs no reply.

**Revisit when** another diagram type becomes common (class, state and ER diagrams only get the count check), or Postbox’s column width or diagram font size changes; then re-measure and refit.
