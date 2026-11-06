# Starter briefs

Six small, well-documented subjects, one per content shape, and one hard one, to tune the skill and its critique on before papers. Each brief is complete: an agent gets only the idea’s question and the facts, draws, and the critique judges the result against the brief. Common subjects first, because a reviewer can tell at a glance whether the idea landed, without reading a paper.

| Brief | Shape | Why it’s here |
|---|---|---|
| [Library](library.md) | Flow | Our own failure case (the Nov 4 field notes), with a known good answer |
| [Seasons](seasons.md) | Mechanism | A famous misconception the picture must not repeat |
| [Compound interest](compound-interest.md) | Change over time | Two quantities that diverge; tempts a table of years |
| [How a bill becomes law](bill-to-law.md) | Process with branches | Tempts a long flowchart with sentences in boxes |
| [Vaccine trial](vaccine-trial.md) | Comparison with uncertainty | Tempts a single big number in a card |
| [Water cycle](water-cycle.md) | Cycle | Tempts a decorative landscape where position means little |
| [Spore archetypes](spore-archetypes.md) | Mix of a few poles | The hard one: rules, not data, whose true shape (a triangle) is hidden. Its own designer drew it wrong twice |

Four more from how people use Postbox (#206): their own data and their own code, not an idea in the message. The person’s files are in `tests/uat/e2e/fixtures/`, put in the workspace by `- files:`. In the data briefs, a bar chart is a trap: each one’s facts are a relation between things that a scatter or a network shows and bars hide.

| Brief | Shape | Why it’s here |
|---|---|---|
| [Subscriptions](subscriptions.md) | Two quantities per item | Cost against use: a scatter with lines of equal cost per use, where bars rank by price |
| [Flaky tests](flaky-tests.md) | Two quantities per item, in groups | Time against failure rate by fixture: the flaky cluster isn’t the slow tests |
| [Book shelf](book-shelf.md) | Network | Exploring your own data before indexing it: 84 files that are 46 works |
| [Pantry](pantry-request.md) | Process with branches | Code: tempts a box per file, the hardest test of drawing what happens |

**Using one:** give the agent the brief’s question and its facts, not its idea, “must show” or traps. Those are for the critique. Run the takeaway test on the result and compare with the idea.

**Which briefs still test the skill:** [references/examples.md](../references/examples.md) shows the maintainer’s verdicts on visuals made from compound interest, the bill, Spore archetypes, its disguise (“titles”) and the three paper briefs, and `- seed: visual-skill` copies those examples into the agent’s folder. An agent with the skill has seen a judged answer to those briefs, so their runs catch regressions and no longer show whether the skill works. The everyday briefs above are the held-out set: no example comes from them, so keep it that way and don’t add their visuals to the examples. Running and shop split, which replace subscriptions and book shelf, are on #884’s branch (`feat/uat-everyday-visual-scenarios`) and not yet on `main`; they’re held out too. Library, seasons, vaccine trial and water cycle have no example either.
