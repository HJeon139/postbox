# Prior work for the experiment plan (E1–E6)

Researcher, 28 October 2026, for critic’s plan “Testing the decisions we made from experience”. Four research subagents read the sources below in full text or, where marked, the abstract only. I checked three citations against arXiv myself (2607.01641, 2402.14848, 2601.17087), and they match. “Preprint” means arXiv with no venue stated. Exact quotes are in quotation marks; the rest is paraphrase. Each source links to its arXiv HTML page where there is one, and otherwise to the author’s PDF or the DOI.

**Short version:** the literature supports the *form* of each experiment, and in three places it changes the design. Nothing measures our exact questions. No paper compares a turn cap with content-based loop detection (E2). None measures whether an agent follows a “read the rest” pointer (E3). None compares self-review with separate review on code (E5). So our results would be new data, not replications.

## E1. Who reruns what (rule 9)

| Source | What it measured | What carries over |
|---|---|---|
| Luo et al., [“An Empirical Analysis of Flaky Tests”](https://mir.cs.illinois.edu/marinov/publications/LuoETAL14FlakyTestsAnalysis.pdf), FSE 2014 ([DOI](https://doi.org/10.1145/2635868.2635920)) | 201 flaky-test fixes in 51 projects. Async wait 45%, concurrency 20%, test order 12% | “Most flaky tests (78%) are flaky the first time they are written”; “Most Async Wait flaky tests can be detected by adding one time delay”. That supports targeting new tests and our injected event lag |
| Lam et al., [iDFlakies](https://doi.org/10.1109/ICST.2019.00038), ICST 2019 | 422 flaky tests; per-test failure rate “from under 1% to over 50%” | Rerunning in the original order gives a failing round only 2.7% of the time. That’s a likely reason why repeating the full suite found nothing in round 1 |
| Bell et al., [DeFlaker](https://doi.org/10.1145/3180155.3180164), ICSE 2018 | 5,328 new failures in 26 projects | A same-process rerun “only identified 23%” of the flaky failures; fresh-process reruns confirmed at least 95% |
| Gruber et al., [“An Empirical Study of Flaky Tests in Python”](https://arxiv.org/html/2101.09077), ICST 2021 (abstract only) | 7,571 flaky Python tests | “95% confidence that a passing test case is not flaky on average would require 170 reruns” |
| Silva et al., [Shaker](https://doi.org/10.1109/ICSME46990.2020.00037), ICSME 2020 (abstract only); Leal et al., [arXiv:2609.25528](https://arxiv.org/html/2609.25528), preprint (abstract only) | CPU and memory stress | 95% vs 37.5% detection on Android; but no gain on Python (37.2% vs 35.8%, p = 0.84). Stress helps only timing-sensitive tests |

**For E1:**
- **10 reruns is a screen, not proof.** A test that fails 1% of the time is caught by 10 reruns only about 10% of the time ($1-0.99^{10}$).
- **Rerun in fresh processes,** and in random order where the runner allows it.
- **Per test, log** the runs, failures, condition (plain, lag) and load average.
- **Count escapes** found later by CI, the integration branch, or the person.

## E2. The pair limit (#492)

| Source | What it measured | What carries over |
|---|---|---|
| Cemri et al., [“Why Do Multi-Agent LLM Systems Fail?”](https://arxiv.org/html/2503.13657) (MAST), arXiv:2503.13657, preprint | 1,642 traces from 7 frameworks; 3 annotators, κ = 0.88 (out-of-domain 0.79); an o1 labeler with few-shot examples κ = 0.77, without them 0.58 | Use its definitions word for word as “loop”. FM-1.3 and FM-1.5, quoted in full under “MAST’s definitions” below. FM-1.5 appears “almost exclusively in failed runs” |
| Li et al., [CAMEL](https://arxiv.org/html/2303.17760), NeurIPS 2023 | 25,000 role-play conversations | Names the “Infinite Loop of Messages… repeatedly thanking each other or saying goodbye”; agents “aware that they are stuck… but are unable to break out of it”. Cap of 40 messages, not evaluated beyond hitting it “low” |
| Qian et al., [ChatDev](https://arxiv.org/html/2307.07924), ACL 2024 | Software-dev agents | Ends a subtask “after two unchanged code modifications or after 10 rounds”: a no-progress rule plus a cap, not evaluated apart |
| Wu et al., [AutoGen](https://arxiv.org/html/2308.08155), arXiv:2308.08155 | ALFWorld, 134 tasks | Agents got “stuck in a loop due to repetitive errors”; advises to “start with humans always in the loop” |
| Hou et al., [“When Agents Do Not Stop”](https://arxiv.org/html/2607.01641), arXiv:2607.01641, preprint | Static analysis of 6,549 agent repos; 68 confirmed loops, 91.9% precision | Hard bounds are often “omitted, misused, ineffective”. That argues for keeping some cap |

**For E2:**
- **Label each wake** with MAST’s FM-1.3 and FM-1.5, plus CAMEL’s observable signs: mutual thanks or goodbyes, a repeated instruction, an “I will…” with no follow-through. Add ChatDev’s no-progress sign: a woken turn that changed nothing.
- **Also label false stops:** a card that held a useful hand-off. That’s the analog of MAST’s FM-3.1 premature termination. No paper measured this cost, which is the one #492 is about.
- **Agreement:** follow MAST’s protocol. Label independently, then settle disagreements and refine the definitions, then label a held-out round and report κ, not percent agreement.
- **Keep a hard bound under policy (c).** Every system studied pairs a content or no-progress signal with a cap, and the literature says agents can’t be trusted to stop themselves.
- **Critic’s concern stands:** hostwakes and p0 were built to trigger the limits. E2 needs ordinary room transcripts too, which only the person can export.

### MAST’s definitions, in full

From [arXiv:2503.13657, Appendix A](https://arxiv.org/html/2503.13657), exactly as written there:
- “FM-1.3: Step repetition - Unnecessary reiteration of previously completed steps in a process, potentially causing delays or errors in task completion.”
- “FM-1.5: Unaware of termination conditions - Lack of recognition or understanding of the criteria that should trigger the termination of the agents’ interaction, potentially leading to unnecessary continuation.”
- “FM-3.1: Premature termination - Ending a dialogue, interaction or task before all necessary information has been exchanged or objectives have been met, potentially resulting in incomplete or incorrect outcomes.” (the analog of a false stop)

## E3. Deliver a mention whole (#499)

| Source | What it measured | What carries over |
|---|---|---|
| Liu et al., [“Lost in the Middle”](https://arxiv.org/html/2307.03172), TACL 2024 | 10–30 documents; 10 documents average 1,475.6 tokens, about our size | 2023 models dipped in the middle: GPT-3.5 76.8% first, 61.2% middle. But on key-value lookup, “Claude-1.3… do nearly perfectly on all evaluated input context lengths” |
| Levy et al., [“Same Task, More Tokens”](https://arxiv.org/html/2402.14848), ACL 2024 | 250–3,000 tokens, 5 models | Reasoning accuracy fell “from 0.92 to 0.68” on average by 3,000 tokens, wherever the key text sat. That’s squarely our length, but for reasoning, not lookup |
| Hsieh et al., [RULER](https://arxiv.org/html/2404.06654), arXiv:2404.06654 | 13 tasks, 4K–128K tokens | About 96–97 at 4K tokens for GPT-4 and Gemini-1.5-Pro; gives no position data |
| Modarressi et al., [NoLiMa](https://arxiv.org/html/2502.05167), ICML 2025 | 13 models | Retrieval falls with length when the question and the fact share no words |
| Hong et al., [“Context Rot”](https://www.trychroma.com/research/context-rot), Chroma technical report, 2025 (not peer reviewed) | Claude Sonnet 4, Opus 4, Haiku 3.5; 11 needle positions | “no notable variation in performance” by position at short lengths; Claude “tend[s] to abstain when uncertain” |
| Packer et al., [MemGPT](https://arxiv.org/html/2310.08560), arXiv:2310.08560 | Paginated retrieval through a function call | “will often stop paging through retriever results before exhausting the retriever database”, the nearest analog to our pointer |

**For E3:**
- **In arms A and C, a fact past 2,000 characters isn’t in the agent’s context at all.** So the first outcome there is whether the agent calls `read_message`; report the call rate as its own measure. Fact position still matters in those arms once the agent has read the rest (critic’s correction), so keep it as a factor in all three.
- **Arm B should be near ceiling at these lengths** on recent models. Its risk is a reasoning cost from more input (Levy), so grade the whole task, not only the fact.
- **Word the question differently from the fact** (NoLiMa). Otherwise arm B wins trivially, and an agent in A can’t tell that the fact is missing.
- **Sample size,** at α = 0.05 and 80% power:
  - A vs B, a large gap such as 50% vs 95%: about 15 per arm, so tester’s 20 is enough.
  - A vs C, a moderate gap such as 70% vs 90%: about 59 per arm, so 20 can’t detect it. Run 50 per arm for that comparison, or say up front that it can only find large effects. This matches critic’s P2.
- **No study measures following an in-text pointer** of the “N of M characters; tool X has the rest” kind. E3 would be the first measurement.

## E5. Adversarial review before merge

| Source | What it measured | What carries over |
|---|---|---|
| Huang et al., [“LLMs Cannot Self-Correct Reasoning Yet”](https://arxiv.org/html/2310.01798), ICLR 2024 | Math and QA, no tools | “after self-correction, the accuracies of all models drop across all benchmarks” (GPT-4 GSM8K 95.5 → 89.0) |
| Kamoi et al., [“When Can LLMs Actually Correct Their Own Mistakes?”](https://arxiv.org/html/2406.01297), TACL 2024 (survey) | Self-correction literature | “self-correction works well in tasks that can use reliable external feedback”, such as code execution; “Bottleneck is in Feedback Generation” |
| Gou et al., [CRITIC](https://arxiv.org/html/2305.11738), ICLR 2024 | Critique with tools | “Without execution feedback from the interpreter, the ability of LLMs to correct programs becomes limited and unstable” |
| Shinn et al., [Reflexion](https://arxiv.org/html/2303.11366), NeurIPS 2023 | HumanEval with self-written, executed tests | 91% vs 80%; but self-reflection without test generation fell below baseline (0.52 vs 0.60), “harmful edits” |
| Du et al., [Multiagent Debate](https://arxiv.org/html/2305.14325), ICML 2024; Smit et al., [“Should we be going MAD?”](https://arxiv.org/html/2311.17371), ICML 2024 | Debate vs one model | Gains on GSM8K (77 → 85), but debate doesn’t “reliably outperform… self-consistency” |
| Panickssery et al., [“LLM Evaluators Recognize and Favor Their Own Generations”](https://arxiv.org/html/2404.13076), NeurIPS 2024 | Summarization | Models recognize and favor their own output; self-preference tracks self-recognition |
| Bacchelli and Bird, [“Expectations, Outcomes, and Challenges of Modern Code Review”](https://sback.it/publications/icse2013.pdf), ICSE 2013 | 570 human review comments at Microsoft | Only 14% were about defects, mostly low-level logic; review “rarely detects deep, subtle, or ‘macro’ level issues” |

**For E5:**
- **Give self-review the same tools** as critic: tests, the gate, the repo. The literature says reliable outside feedback decides it, more than a second agent does. With fewer tools, E5 would measure the tools, not the separate reviewer.
- **For each defect, log** whether execution found it or reading did.
- **Compare a critic on the same model with one on a different model,** on the same items if affordable, since self-preference is a known effect.
- **Count false positives and harmful edits,** not only true defects.
- **Set severity and ground truth before the round.** Then settle escapes with an adjudicator who doesn’t know which reviewer found what.
- **One round is provisional.** At 1 defect per 3 items, 3 hits in 9 items gives a 95% interval of roughly 7–70%. Plan 15–20 items or more before the decision rule is applied.

## E6. Real-agent UAT confirms; a deterministic test decides (rule 4)

| Source | What it measured | What carries over |
|---|---|---|
| Yao et al., [τ-bench](https://arxiv.org/html/2406.12045), arXiv:2406.12045 | Tool agents with an LLM user; pass^k, “the chance that all k i.i.d. task trials are successful” | gpt-4o “quite inconsistent (pass^8 <25% in retail)”. Of 40 failed trajectories, 4 were the simulated user’s fault and 36 the agent’s: the precedent for our attribution |
| Kapoor et al., [“AI Agents That Matter”](https://arxiv.org/html/2407.01502), arXiv:2407.01502 | 5 runs per agent, t-intervals | “LLMs aren’t deterministic even at temperature zero”; evaluator bugs marked failures as passes; the runner itself caused drift (rate limits) |
| Seshadri et al., [“Lost in Simulation”](https://arxiv.org/html/2601.17087), arXiv:2601.17087, preprint (abstract only) | τ-bench retail across user LLMs | Success rates vary “up to 9 percentage points across different user LLMs”; simulated users are miscalibrated |
| Zheng et al., [“Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena”](https://arxiv.org/html/2306.05685), NeurIPS 2023 | LLM judges vs humans | GPT-4 agreed with humans 85% without ties; position bias. A reference answer cut math judging errors from 14/20 to 3/20 |

**For E6:**
- **Report pass^k** with τ-bench’s unbiased estimator, over n runs.
- **Ten runs can show that a scenario is unreliable, but can’t certify that it’s reliable:** the interval is roughly ±0.3 near 50%. That supports rule 4 as written.
- **Attribute each drift** by reading the trajectory, as τ-bench did: agent, simulated person, or runner.
- **Treat the tester model as a factor.** Run the simulated person at temperature 0 if its backend allows it.
- **Give the verifier the scripted checkpoint as its reference answer,** and spot-check its verdicts by hand.

## E4. The turn summary (#484)

No prior work was searched for this one. It’s a replay of our own data through two versions of `catchUp`, with nothing to generalize from.

## What I couldn’t find

- A comparison of a consecutive-turn cap with content-based loop detection (E2).
- Any measure of agents following a truncation pointer (E3).
- Self-review vs separate review on real code diffs (E5).
- The value of a “red run” measured directly (E1).

We didn’t search further for E2 (SWE-agent’s repeated-action analysis, Who&When, TRAIL) or the mutation-testing literature for red runs. Other relevant work may exist.
