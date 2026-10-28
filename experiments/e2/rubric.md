# E2 rubric, revision 4: does a wake hand over anything new?

Revision 1 was written 28 October 2026 before either labeler looked at the wakes, and its pilot (51 wakes) is kept as `e2-labels-*-pilot.jsonl`. Revision 2 adds MAST’s labels (plan.md revision 5, sha256 a3132042dbde0fdd…). Revision 3 settles the pilot’s three disagreements and adds the two rules critic raised. Revision 4 only replaces MAST’s two shortened quotes with the full definitions from the paper’s Appendix A (as quoted in `.scratch/grooming/prior-work.md`); the working definitions after “Here:” are unchanged. Both labelers’ held-out labels were made under revision 3.

## The unit

One wake: a message one agent sends that wakes another agent (an @-mention in its reply, or a `wake_agent` call). The labeler sees, for each wake, only:
- the sender’s handle and the target’s handle;
- the wake’s text;
- the text of the previous 3 messages between the same two agents, oldest first.

The labeler doesn’t see which policy would stop it, whether a card was raised, or the timestamps.

## The label

**NEW** if the wake’s text hands the target at least one of these, not already in the previous 3 messages between them:
1. a task or request to do something;
2. a finding, result, number, file, commit or link;
3. a question that needs an answer;
4. a change to a draft, plan or decision, or an answer to a question the target asked.

**NOTHING** otherwise. Typical: thanks, acknowledgments (“noted”, “got it”), “nothing more needed”, restating what was already said, saying it won’t reply, or asking for something already given.

**Addressed to someone else:** a wake whose content is meant for someone other than its target (the person, or another agent) hands the target nothing, so it’s NOTHING, tagged `other`, whatever it holds.

**Resent:** a wake that restates or summarizes something its sender already sent the target in the previous 3 messages, even reworded, is NOTHING, FM-1.3. A wake whose text is identical to an earlier wake from the same sender to the same target anywhere in the data is labeled NOTHING, FM-1.3 automatically (`e2-resends.txt`), and isn’t shown to labelers.

**Ties:** if the text holds both, it’s NEW. If the labeler can’t tell from the text, it’s NOTHING, and the labeler marks it `unsure`.

## MAST tag, on each NOTHING wake

From Cemri et al., “Why Do Multi-Agent LLM Systems Fail?” (MAST, arXiv:2503.13657):
- **FM-1.3, step repetition:** “Unnecessary reiteration of previously completed steps in a process, potentially causing delays or errors in task completion.”. Here: the wake repeats a request, a result or a message already given in the previous 3 messages, or resends something the target already has.
- **FM-1.5, unaware of termination conditions:** “Lack of recognition or understanding of the criteria that should trigger the termination of the agents’ interaction, potentially leading to unnecessary continuation.”. Here: the exchange is already finished, and the wake keeps it going: thanks, goodbyes, “nothing more needed”, “I won’t reply”, “I’m not resending”.
- If both fit, FM-1.5. If neither fits, `other`.

Observable signs that help (CAMEL, ChatDev, from the prior work): mutual thanks or goodbyes; a repeated instruction; an “I will…” with no follow-through.

## False stop, on each card (labeled after the replay, per policy)

A card is a **false stop** when the wake it held is NEW: the analog of MAST’s FM-3.1, premature termination, “Ending a dialogue, interaction or task before all necessary information has been exchanged or objectives have been met, potentially resulting in incomplete or incorrect outcomes.” The labeler judges only the wake’s label; the replay decides which wakes each policy would have held.

## A loop

A run of at least 3 consecutive NOTHING wakes between the same two agents, with no message from the person in between.

## Procedure

1. Extract all wakes with the context above into `e2-wakes.jsonl`, shuffled, one id each. Record the file’s hash. One wake message counts once per target: `e2-wakes-r2.jsonl` drops 71 extra entries where a target’s later turns pointed back at the same message (437 wakes remain).
2. Pilot, by MAST’s protocol: critic and tester each label the same random 10% on their own, then settle disagreements and refine this rubric (a new revision, with its hash). Then a fresh held-out 10%, labeled on its own by each. Cohen’s kappa on the held-out round ≥ 0.6 to go on, for the NEW/NOTHING label; kappa for the MAST tag is reported too.
3. Both label the rest. Disagreements are settled by discussion, and each is listed with its outcome.
4. Only then are the policies replayed over the settled labels.

## Pilot settlements (revision 1 pilot, 46 wakes after duplicates were dropped; kappa 0.784)

- `1cbb2484b0` (critic → researcher): tester NEW, critic NOTHING. Settled NOTHING, FM-1.3: its list of fixes summarizes the full fixes critic sent researcher in the message just before.
- `3522fdc104` (critic → developer): tester NEW, critic NOTHING. Settled NOTHING, FM-1.3: it restates that the folder is empty, as critic’s previous two messages said, and it’s addressed to researcher.
- `320804dee8` (researcher → critic): tester NOTHING, critic NEW. Settled NOTHING, `other`: it asks the person, not critic, to pick fixes (the new “addressed to someone else” rule).
