# Developer standards

Follow the person’s request and the repository’s instructions. Before changing code, inspect the relevant implementation, tests, design documentation, configuration and working-tree state. Ask about ambiguity when it changes behavior, scope, compatibility or risk; otherwise state the assumption you used. Preserve unrelated work.

The repository’s configured linters, type checker, tests and CI define enforced rule levels. Do not duplicate those levels in comments or general documentation.

## Responding to a request

- Make the smallest change that fully satisfies the request. Prefer the language, platform and repository’s existing facilities over new code or dependencies.
- Treat a reported defect as one observed case. Find its cause and inspect likely sibling cases, but modify only the agreed scope. Fix regressions introduced by your change. Report evidenced follow-up work; create an issue only when asked or authorized.
- Do not add dependencies, public API, schemas, migrations or test-only production behavior unless the requested change requires them.
- Do not discard unrelated edits or use destructive repository operations. Do not commit, push, publish, deploy, open an issue or open a review unless the person asks.

## Code

- Follow the surrounding code and the language’s idioms. If repository instructions conflict with the code, investigate and report the discrepancy rather than guessing.
- Do not suppress a check merely to pass. Use a narrow, documented exception only when the rule genuinely does not apply and repository policy permits it.
- Preserve an error’s cause. At a user-facing boundary, say what happened and what the person can do next. Prefer stable structured fields over parsing message text. Only process entry points terminate the process.
- Use booleans for genuinely binary values and precise named types for multiple domain states. Validate external values before dispatching on them, and handle internal variants exhaustively.
- Pass behavior-shaping values explicitly at process and trust boundaries. Do not use a fallback that hides missing wiring or invalid state. Intentional defaults and compatibility fallbacks must be documented and tested.
- Await, return or explicitly handle asynchronous work. Give blocking or potentially unbounded work a timeout and a cancellation path when the platform supports one.
- Treat user, tool, process, network and persisted input as untrusted. Validate it at the boundary. Canonicalize only as the contract defines; otherwise reject invalid or ambiguous input.
- Never execute untrusted external content as code or pass it through an unsafe evaluator. Spawn with an argument list when passing variable input, and never interpolate untrusted values into a shell command. Put no secrets in code, logs, fixtures or commits.
- Do not add API surface “for later.” Verify dependency behavior from authoritative documentation, resolved source or types, and existing tests. Run a real integration only when it is in scope and authorized.

## Tests and evidence

- Add or update tests when the requested behavior requires them. Give each test one behavioral reason to fail, name it clearly, assert the specific result or error, and, when relevant, assert that forbidden side effects did not occur.
- In unit tests, inject nondeterministic or external dependencies such as the network, process state and clock. Use real dependencies only in the repository’s designated integration or end-to-end tests.
- Derive protocol fixtures from recorded or otherwise authoritative behavior. You may remove secrets, local paths and nondeterministic identifiers, but do not invent or alter semantics to make a test pass. Record the fixture’s provenance.
- While iterating, run focused checks. Before calling the change complete, run the repository-prescribed full gate and any additional check required by the changed surface.
- Verify that new tests and checks were discovered and exercised. Read outputs when the claim concerns what happened; a counter alone is insufficient.
- Investigate suspiciously empty, uniform or perfect results before relying on them. Explain whether the exercised cases support the claim. If they do not, fix the verification when it is in scope or report the gap.
- For a regression check, demonstrate failure against the pre-fix behavior when practical and safe, without leaving planted changes behind.

## Reviewing your change

Review the final diff as a skeptical maintainer:
1. **Correctness.** Does it satisfy the request, preserve required behavior and handle relevant failure paths? Is each conclusion supported by inspected source, repository documentation, a test, a fixture or a measurement appropriate to the claim?
2. **Consistency.** Does it follow the design documents, surrounding code and repository conventions?
3. **Clarity.** Can a reader understand the intent and behavior without reconstructing the work session?

Name the concrete idiom, invariant or missing behavior behind every finding. Fix confirmed defects in the change, then rerun affected checks.

## Comments and documentation

- Docstrings describe interfaces. Comments explain non-obvious constraints or reasons the code cannot express; do not narrate the code.
- Put durable, cross-module design decisions in the repository’s design documentation. Use a concise local comment for a non-obvious invariant, and use references that will remain meaningful.
- Keep living documentation accurate. Update diagrams with the prose they represent, and do not present planned or partial work as complete.
- Follow repository policy for TODOs. Do not leave an unowned TODO or create a tracking issue without authorization.

## Commits and reviews

- If asked to commit, follow the repository’s commit format and keep each commit to one concern. Do not rewrite commits that have been published or reviewed; once review begins, answer feedback with new commits.
- A review description gives the context, changed behavior, exact validation commands and results, and remaining limitations. Keep it concise and reproducible.
- In the handoff, list changed files, exact checks and outcomes, assumptions, and anything not verified. Do not call the work complete when a required gate did not run or failed.
