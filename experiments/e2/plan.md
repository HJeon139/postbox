# Experiment plan: test the room’s decisions with data (merged, revision 8)

Tester’s plan, merged with critic’s six-experiment plan and revised for critic’s review of 28 October 2026. Revision 3, made before any data, pins E1’s arms to branches and scores E1 automatically (critic’s P2 and P3 on revision 2). Revision 4, also before any data, folds in the prior work (`.scratch/grooming/prior-work.md`): E1’s primary measure in the cut arms, E2’s backstop, and E5’s tools and sample. Revision 5, before any data, adds the rest of researcher’s and critic’s points on the prior work: NoLiMa wording in E1, MAST labels and a held-out agreement round in E2, fresh processes in E3, and an interval rule in E5. Revision 6, before the replay, adds critic’s analysis rule for E2: loops and false stops are counted twice, and decided on the FM-1.3 and FM-1.5 wakes only. Revision 7, after critic’s review of the first E2 replay and before it runs again, fixes the replay’s model of Postbox and adds a detector the content rule can actually use (E2, “Replay model”). The first replay’s result is kept as `e2-report.md` and isn’t used for the decision. This file is fixed before any data comes in; its SHA-256 is cited in each report. A change to it after data arrives is a new revision, and the report says which revision it ran under.

## Rules for every experiment

- **Decision rules are fixed here, in advance.** A result that misses its rule doesn’t support the decision, whatever else it shows.
- **Whoever proposed a decision doesn’t judge its result.** Tester runs it; critic checks the analysis against the rule.
- **Metrics not named here are exploratory,** reported as such, never as evidence.
- **Exact numbers, with the command and exit code** (rule 1), null results included.
- **Data:** `uat-runs/*/data`, the test fixtures, and an export of this room that the person provides (AGENTS.md rules out reading `~/.postbox`). Sources are reported separately.
- **A source read from its abstract only can shape a design, but not decide a result.**
- **Anything already run sticks to the revision it ran under,** and its report says which.
- **Prior work first:** researcher summarizes the relevant papers for each experiment, what each measured and whether it carries over. Where the literature settles a question, the experiment shrinks or is dropped.

## E1. #499: deliver a mention whole, or cut it with a pointer

- **Arms:** A, the cut and pointer, on `fix/484-catch-up` at `2796f6b` (not `main`, whose summary also differs in how it orders and caps mentions); B, whole up to a bound, on `fix/499-whole-mentions` at `e92f045` with `READING.mention` = 16,000; C, arm A plus a plain instruction to follow the pointer. A and B then differ only in the bound.
- **Delivery path:** each arm’s input is built by Postbox’s real `catchUp` and `describeItem` and delivered in a real Claude Code turn. No prompt is written by hand. Claude Code agents only (a Kiro agent may lack `read_message`, #489).
- **Task:** one scripted sender message that @-mentions the agent, holding a **control fact before character 2,000** and a **target fact** placed just past 2,000, in the middle, or at the end. The agent gets one task that needs both facts. Each question shares no words with its fact (NoLiMa, Modarressi et al., ICML 2025), so the agent has to find the fact, not match the question’s wording; the code word is the answer, not part of the question.
- **Sample:** at 5,000 characters, 50 turns per arm per position (450 turns); at 2,500 and 10,000 characters, target just past 2,000 only, 20 turns per arm (120 turns). Claude Sonnet 5.5 at low effort. With 50 per arm, a two-sided Fisher test at 80% power detects about a 25-point gap; with 20, about 40 points.
- **Scoring, automatic:** each fact is a unique code word, new for every turn. A fact counts as used when the reply contains its code word exactly. “Resend asked” is the reply calling `wake_agent` or @-mentioning the sender. No reply is judged by hand, so E1 needs no labels.
- **Metrics:** both facts used correctly; `read_message` called; resend asked; input tokens; cost. In arms A and C a fact past the cut isn’t in the agent’s context unless it calls `read_message`, so there `read_message` called is reported first, and position is analyzed within the turns that read the rest.
- **Decision rule:** keep #499 (B) if, at 5,000 characters, B’s both-facts-correct rate beats A’s by at least 20 points with a 95% interval excluding 0, B’s control-fact rate is no more than 5 points below A’s, and B’s input tokens rise by no more than 25%. If B fails and C beats A by the same margin, prefer C. Otherwise keep A, and report that neither change helped.
- **Cost:** about $35.

## E2. #492: the pair limit, stopping loops without stopping discourse

- **Policies:** the limit at 2 (now); the limit at 6; a content rule (a wake counts only when it hands over nothing new), always with the chain limit (`HOP_LIMIT`, 10) kept as a hard backstop, since every system in the prior work pairs a no-progress signal with a hard cap.
- **Data:** the recorded wakes in the UAT runs, **and** in an export of this working room. Reported separately, since hostwakes and p0 were written to set off the limits.
- **Labels:** by `e2-rubric.md` revision 2: each wake NEW or NOTHING; each NOTHING wake also tagged with MAST’s FM-1.3 (step repetition) or FM-1.5 (unaware of termination conditions), using MAST’s definitions; and each card labeled a false stop when it held a NEW wake. A loop is a run of at least 3 NOTHING wakes. Agreement follows MAST’s protocol: critic and tester label a pilot of about 10% independently, settle disagreements and refine the rubric, then label a fresh held-out 10%; the rest is labeled only if Cohen’s kappa on the held-out round is at least 0.6. Each disagreement is listed with how it was settled. The first pilot (51 wakes, by rubric revision 1) counts as that pilot.
- **Replay model (revision 7):**
  - **Counts belong to a conversation:** a topic thread’s wakes count with its conversation’s (`parentId`).
  - **Resets:** a message or command from the person, and the person answering a wake card (“Allowed: …”, “Didn’t allow …” lines), clear every count.
  - **One card at a time (revision 8):** when a policy stops a wake, one card opens. A later wake goes through as usual if it trips neither the pair rule nor the chain limit; only a wake that would need a card itself waits on the open one (or is refused, on `main`), and counts as a false stop if it’s NEW. The card counts once. Revision 7 held every later wake, which overcounted.
  - **Answering an add card** (“Added @x…”, “Didn’t add @x…”) also resets the counts.
  - **The content rule’s count resets** on each wake that hands over something new, as #492 proposes, so only wakes in a row with nothing new add up.
  - **Two content rules are scored.** The *oracle* uses our settled labels, and shows the best a content rule could do. The *detector* uses only what Postbox can see, fixed here before it runs: a wake counts as having nothing new if (a) its words overlap one of the pair’s previous 3 messages with a Jaccard index of at least 0.6 (lowercased words of 3 or more letters), or (b) the turn it woke ran no steps (no tool calls) and replied in under 300 characters. The detector’s calls are compared with our labels (agreement and kappa) before its replay is read. **The decision rule is applied to the detector’s replay**, not the oracle’s.
- **Limit of a replay:** it scores only the first point where a policy would have stopped a chain; what agents would have done next can’t be replayed.
- **Metrics:** false alarms (cards on wakes with something new), misses (loop wakes let through), cards per run, and the FM-1.3 and FM-1.5 counts among the misses.
- **Two counts:** each policy’s loops, misses and false stops are reported twice: with every NOTHING wake, and with only the FM-1.3 and FM-1.5 wakes. A NOTHING wake tagged `other` is a message meant for someone else (mostly the person) that happens to mention an agent; stopping it is #481’s and #331’s problem, not a loop stopped, so it doesn’t count toward the decision.
- **Decision rule:** choose the policy with the fewest false alarms on the working-room data that lets no loop run past 4 wakes, counting only FM-1.3 and FM-1.5 wakes as loop wakes. If none meets that, keep the limit at 2. When the winner’s margin is within 3 false stops on the working-room data, the result is reported as weak, and the rule as written still chooses.
- **Cost:** $0.

## E3. Rule 9: who reruns what

- **Design:** paired. On each branch in the next round, both regimes run: the targeted checks (a red run, and each changed test 10 times, each rerun in a fresh process, specs also with `POSTBOX_STREAM_LAG=300`) and the full reruns (the gate and both browser runs). Each check logs its result, its minutes and the load average.
- **Metrics:** defects each regime finds; minutes; escapes found later by CI, the integration branch or the person’s PR review. Ten reruns are a screen, not proof: they catch a 1% flake only about 10% of the time, and the report says so.
- **Decision rule:** keep rule 9 if the targeted checks find at least 90% of the defects the full reruns find, for at most a third of the minutes. Otherwise add back the check that caught what they missed.
- **Cost:** $0 in model usage; machine time.

## E4. #484: did the old turn summary drop mentions?

- **Design:** replay each recorded store through the old and the new `catchUp`. Count mentions of the receiving agent each summary left out. A label rule, written first: “asked again” means the receiving agent’s next message asks for, or says it lacks, what the left-out mention held.
- **Decision rule:** if the old summary left out a mention in fewer than 1 in 100 summaries, #484 isn’t why reports went missing, and the cause is looked for elsewhere (#485 is one candidate).
- **Cost:** $0.

## E5. Adversarial review before merge

- **Design:** each author reviews its own diff with critic’s checklist before critic does, with the same tools critic uses (the tests, the gate, the repository). It runs until 15 to 20 items have been reviewed, across rounds; one round of about 9 items can’t settle it. Log which defects each review finds, and which CI, tester or the person find later.
- **Decision rule:** across the 15 to 20 items, keep the separate review if the 95% interval for its share of P2-or-worse defects that the self-review missed stays above 10%. If the interval includes 10%, keep collecting; if it falls below, drop the separate review for items under a size to be set then.
- **Cost:** $0.

## E6. A real-agent UAT confirms; a deterministic test decides (rule 4)

- **Design:** on the next 10 scenario runs, mark each scripted checkpoint as reached as scripted or not, and record which side drifted: the agents, the simulated person, or the runner (`action held` lines in `run.log`).
- **Decision rule:** keep rule 4 if more than 1 in 5 runs drift from the script or misjudge their result.
- **Cost:** $0 beyond runs already planned.

## Not tested now

Blind estimation through files; notify against wake (#472, not built); #466’s retry ceilings.

## Order

Prior work, then E2, E4 and E6 (free), then E1 (paid), then E3 and E5 in the next round.
