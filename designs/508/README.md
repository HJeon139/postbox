# #508: delivery records and a windowed transcript

The working documents for [#508](https://github.com/HJeon139/postbox/issues/508), gathered in one place so implementation steps can cite them by path. They were written and reviewed in the “rearchitecture-508” room in Agent research, 28 October 2026, by researcher, developer, critic, gemini and gpt, with the person approving each.

**Where it stands** (31 October 2026): the design is at revision 12. The Redis decision of 28 October was recalled on 31 October, so persistence stays on JSON Lines with whole, fsynced commits (`storage-design.md`). Now (#537) and Harness (#539) have merged. The Store step (#525) is replaced by steps 1a and 1b, with a sharded snapshot (S2) only if a stall still passes 50 ms after the snapshot is written in pieces and old work entries leave state. #553 is on hold and closes when 1a’s PR opens. A1, B1 and the remote read contract are in progress; `execution-plan.md` gives the gates a step passes before it merges.

```mermaid
flowchart TD
  R["requirements.md: what, and the test that decides each"] --> D["design.md: how"]
  R --> T["testing-strategy.md: UAT scenarios that confirm"]
  T --> D
  U["room-rules.md: how the agents coordinate"] -.-> D
  E["execution-plan.md: who builds each step, in what order"] --> D
  U -.-> E
```

| Document | What it holds | Status |
|---|---|---|
| [`requirements.md`](requirements.md) | The functional requirements (DL, MD, AT, SW, PF, CX, MS), each with its sources, including storage (ST) and store security (SR), and in “Acceptance, test first” the layer and test that decide it | Revision 4.5, approved (4.3 in [comment 6482761957](https://github.com/HJeon139/postbox/issues/508#issuecomment-6482761957)) |
| [`design.md`](design.md) | The design: one record collection, delivery decided by how a turn ends, a windowed browser, and storage on the JSON Lines log with one-line commits | Revision 12, approved |
| [`storage-design.md`](storage-design.md) | The storage engineering design: the line format, the writer, recovery, failing closed, the epoch, the lock, snapshots, crash points, performance, and a test plan | Draft 5, for the principal-engineer review |
| [`testing-strategy.md`](testing-strategy.md) | The `delivery.md` and `bigroom.md` UAT scenarios, with their triggers, checks, seed and fault launcher. A run confirms; a spec written first decides. | Approved, with names aligned to the requirements |
| [`room-rules.md`](room-rules.md) | How agents on Claude Code, Codex and Antigravity coordinate on this work, and the bug behind each rule | Approved |
| [`execution-plan.md`](execution-plan.md) | Who builds, reviews and confirms each step, the waves steps run in, the gates before a merge, and what must be decided before the first step | Revision 2, approved |

**Related issues:** #516 (room assets), #14 (room notes), #521 (`AskUserQuestion` shows as a permission card), #515 (resumed Claude sessions keep their first guide).

**Keeping these current:** each step’s PR updates the document it changes, in the same change, as `designs/AGENTS.md` asks. Once a document’s decisions move into `architecture.md` or `intent.md`, it says so at its top and stops changing.
