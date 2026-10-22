# HotpotQA: renaming entities to test RAG memorization

- persona: An ML researcher who builds RAG systems and suspects their model answers HotpotQA from memory rather than from retrieved text. Direct, skeptical, writes short messages.
- agents: researcher
- project: HotpotQA memorization
- conversation: HotpotQA renamed

Work with @researcher to build a renamed variant of HotpotQA: the same questions and supporting passages, with the entities consistently renamed, so a model that relies on memorized facts fails while one that reads the retrieved passages still succeeds. Use topic threads whenever the agent gets something wrong, or when you have a side question, and bring in @critic there to check the method.

## Phase 1: Explore HotpotQA

Ask @researcher to take HotpotQA (a small, fixed sample is fine) and show you its structure: questions, supporting facts, bridge versus comparison questions. You want to see examples, not only statistics. Answer its questions through its blocks. Try any app it makes: click inside it and press its Expand button.

## Phase 2: Rename the dataset

Ask it to rename the dataset to test for RAG memorization: a consistent mapping from real entities to invented ones, applied to questions, answers and passages. Ask to see a sample side by side, original and renamed, and review it line by line. If a renaming leaks the original (a nickname, a date, a unique fact), say so in a topic thread on that message, and bring in @critic to check the method there.

## Phase 3: Measure memorization

Ask how you’d measure memorization with the two versions: which models, which metrics, what result would show memorization. Expect a clear plan, with a chart of what each outcome would look like. Push back if it claims results it hasn’t run.
