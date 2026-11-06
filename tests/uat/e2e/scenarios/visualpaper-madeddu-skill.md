# Visual paper, pinned, with the visual skill: Madeddu (network)

- persona: A software engineer who reads outside their field on weekends and wants to understand one new paper well enough to explain it to a friend. Curious, short on patience for walls of text, and can’t say what a good diagram looks like until they see one. Writes short messages and never says how an answer should look.
- agents: researcher
- models: persona
- seed: visual-skill
- steps: 12
- project: Paper explainers
- conversation: Madeddu

With the draft visual-explainer skill planted as a project skill (`- seed: visual-skill`), on the development set (designs/skills/visual-explainer/briefs/papers/). Otherwise identical to [the run without it](visualpaper-madeddu.md). The pinned variant of [the visual paper eval](visualpaper.md) for [#206](https://github.com/HJeon139/postbox/issues/206): the same paper every run, so a change in score comes from the agent or its prompt, not the paper. Madeddu, [arXiv:2610.24728](https://arxiv.org/abs/2610.24728), covers a model of how high blood sugar damages bone marrow. Its content is a network of parts that push on each other. The baseline is [`marrow-toy`](https://github.com/HJeon139/postbox/tree/docs/agentic-ux-examples/examples/agentic-apps/marrow-toy), the app a room reached after several rounds of a person’s feedback; scored on the same rubric, it’s the bar a first version should reach.

Write as you would to a colleague. Don’t name a chart type, a library, Postbox’s tools or the word “app”: the run measures what the agent chooses. Don’t open the baseline app. Judge every visual from its screenshot, not from what the agent says it drew.

## Phase 1: The paper, explained

Send the link https://arxiv.org/abs/2610.24728 and say: “Read this one in full and explain it to me visually. I want to actually get it.” Then wait.

Pass on all six:
1. **The paper is named.** The reply names the paper it explains with its arXiv link, and it’s this one.
2. **Domain terms are defined.** Each field-specific term in the reply is a glossary term (a dotted link with a hover card), defined the first time it appears.
3. **No coined terms, or they’re disclosed.** Names the agent made up for this session (“Stage B”, “the gate loop”) don’t appear, or each is defined and says it’s the agent’s own name, not the paper’s.
4. **It’s an app.** The visual is a Postbox app, not only a Markdown diagram.
5. **It uses a bundled library.** The app draws with `postbox.load("d3" | "katex" | "mermaid")` or `postbox.charts`.
6. **No text in boxes.** No shape holds more than about six words, and the picture would lose something as a table.

Also record, without failing the phase, whether the agent read past the abstract: two or more facts in the visual (a number, an equation, a figure’s result) that only the body of the paper has.

## Phase 2: Does it explain?

Without rereading the paper, try to say in one sentence what the paper found. Then ask: “If blood sugar comes back down, does the marrow recover, and which part recovers last?” If the app has a control, use it first.

Pass if you could answer your own question from the visual, or with one use of its control. Fail if you needed the agent’s prose to answer it.

## Phase 3: One round of feedback

Give one short piece of feedback, as a person would, on whatever is weakest. Use the first that applies:
- If shapes hold sentences: “This is a table in boxes. Draw it.”
- If there are several panels of equal weight: “Which one of these is the point?”
- If something moves for no reason: “Why is it animated?”
- Otherwise: “What should I look at first?”

Pass if the next version fixes what you named, in the same app (update_app, not a new one), and doesn’t break a phase 1 criterion that passed. Fail, and file it, if the agent says it fixed something the new screenshot doesn’t show.
