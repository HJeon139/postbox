# E2 report, third replay (plan revision 8): the pair limit (#492)

Run by tester, 28 October 2026, under plan.md revision 8 (sha256 a6f781d3e0436198…), after critic’s reviews of the first and second replays. The first replay (`e2-report.md`) isn’t used for the decision; the second (revision 7) is shown beside this one. For critic to check against the decision rule.

**Revision 8’s one change to the model:** while a card is open, a wake that trips neither the pair rule nor the chain limit goes through, as in Postbox (`askToWake` is called only past a limit). Only a wake that would need a card itself waits on the open one. Revision 7 held every later wake. Answering an add card also resets the counts now. Command: `python3 -I e2-replay3.py > e2-replay3-result.json`, exit 0; script sha256 66045c714b906edd…, result a5f12d61a5495739….

## Data

437 wakes: 258 from this working room, and 179 from 14 UAT runs across 7 scenarios (p0 ×3, hostwakes ×4, remotehosts ×2, workroom ×2, needsnav ×2, longresearch, uc03-verse). A wake is one agent’s message that started another agent’s turn. The UAT wakes are published with their text, redacted; this room’s wakes are published as labels and order only.

## What changed from the first replay (critic’s P1 and P2s)

- **The content rule runs on a detector,** written into plan revision 7 before it ran: a wake counts as having nothing new if its words overlap one of the pair’s previous 3 messages with a Jaccard index of at least 0.6, or the turn it woke ran no steps and replied in under 300 characters. The oracle (our labels) is kept beside it, for comparison only.
- **The content rule’s count resets** on each wake the rule reads as new.
- **Resets:** a message from the person, and the person answering a wake card (“Allowed: @x wakes @y” and “Didn’t allow” lines, 34 in this room). Permission answers (“Allowed: @x to run a command…”) aren’t wake cards and don’t reset. No command from the person (`!`) appears among this room’s items.
- **One card at a time:** after a stop, every later wake in that conversation waits on the card until the next reset; each NEW wake that waits counts as a false stop, and the card counts once.
- **Counts per conversation,** with topic threads mapped to their conversation: 5 conversations in this room’s data, 15 in the UAT runs.

Command: `python3 -I e2-replay2.py > e2-replay2-result.json`, exit 0. Script sha256 07ac584aa9a40816…, result 82433ea80e05561f…. Labels unchanged: `e2-labels-final.jsonl`, sha256 7ee240be3177664f….

## The detector against our labels

| | Count |
|---|---|
| Wakes | 437 |
| Detector agrees with our NEW/NOTHING label | 245 (56%), Cohen’s kappa **0.115** |
| Loop wakes (FM-1.3 or FM-1.5) it catches | 13 of 36 |
| NEW wakes it calls “nothing new” | 31 |

A kappa of 0.115 is barely better than chance. The detector as #492 sketched it doesn’t tell work from loops in this data.

## Results, counting only FM-1.3 and FM-1.5 as loop wakes (the count that decides)

| Data | Policy | Cards (r8) | Wakes held (r8) | False stops (r8) | False stops (r7) | Longest loop let through (r8) |
|---|---|---|---|---|---|---|
| Working room | limit 2 (now) | 12 | 2 | **8** | 21 | 2 |
| Working room | limit 6 | 2 | 1 | **2** | 2 | 2 |
| Working room | content rule, detector | 2 | 1 | **2** | 2 | 2 |
| Working room | content rule, oracle | 2 | 1 | 2 | 2 | 2 |
| UAT runs | limit 2 (now) | 15 | 12 | 5 | 5 | 1 |
| UAT runs | limit 6 | 0 | 0 | 0 | 0 | 2 |
| UAT runs | content rule, detector | 2 | 0 | 0 | 0 | 2 |
| UAT runs | content rule, oracle | 0 | 0 | 0 | 0 | 2 |

Critic was right that revision 7 overcounted limit 2: its false stops in the working room fall from 21 to 8 once wakes under the limits go through while a card waits. The other policies don’t change. In the working room, both cards under limit 6 and under either content rule come from the chain limit.

## Against the decision rule

“Choose the policy with the fewest false alarms on the working-room data that lets no loop run past 4 wakes, counting only FM-1.3 and FM-1.5; the UAT data only breaks a tie. If none meets that, keep the limit at 2. When the winner’s margin is within 3 false stops, report the result as weak.”

- **Limit 6 and the detector’s content rule tie on the working room:** 2 false stops each, against 8 for the limit at 2. Neither lets a loop past 2 wakes.
- **The UAT data doesn’t break the tie:** 0 false stops each.
- **The rule as written doesn’t choose between them.** It does rule out keeping the limit at 2: both alternatives meet the loop condition with 6 fewer false stops in the working room, which is outside the rule’s 3-stop margin for a weak result.
- **Between the two tied policies, the margin is 0, so the choice is weak by the rule’s own terms.** That they tie isn’t a fluke of the detector: the oracle content rule ties too, because in this data no pair ever ran 3 loop wakes in a row.

## What the data supports, and what it can’t show

- **Supported:** raising the pair limit above 2. In this working room it cut false stops from 8 to 2, and in the UAT runs from 5 to 0, without letting a loop past 2 wakes. The effect is smaller than revision 7 showed.
- **Not supported: a content rule built on this detector** (word overlap of at least 0.6 with the pair’s previous 3 messages, or a woken turn with no steps and under 300 characters). It ties with a plain higher limit, and the detector agrees with our labels at a kappa of 0.115. This doesn’t show that no content rule can work: a detector specified in #492 itself, and tested the same way, could. This detector was also written after both labelers had seen the labels, though before the run.
- **Can’t show:** what happens in a long loop. The data was recorded under the limit at 2 and the chain limit at 10, so no pair ran more than 2 wakes in a row before a card or the person. In the second count (every NOTHING wake, exploratory), limit 6 and the detector each let a run of 5 NOTHING wakes through in the UAT runs (revision 8; revision 7 showed 6 and 5). Those runs are messages meant for someone else, not loops, but they show how much a higher limit lets through when agents misaddress messages.

## Unchanged from the first report

- 180 of 437 wakes (41%) are messages meant for someone else that happen to @-mention an agent: #481’s and #331’s problem.
- Neither labeler was blind to the source.

## Critic’s check (approved, 28 October 2026)

Critic diffed `e2-replay2.py` against `e2-replay3.py`, matched the hashes and the table to `e2-replay3-result.json`, and approved revision 8, with two caveats added here:
- **The broader count tells against limit 6.** Counting every NOTHING wake (exploratory), limit 6 lets a run of 5 through in the UAT runs, past the rule’s 4. Those wakes are mostly `other`, so they aren’t a loop by our definition, but it’s the one place limit 6 does worse.
- **The evidence is small:** one working room, 8 false stops against 2, and no loop longer than 2 wakes in the data. The chain limit stays underneath as the backstop.

## What E2 supports for #492

Raise the pair limit from 2 (6 performs as well as anything tested), and keep the chain limit. Don’t build the content rule on this detector; the content rule stays open until #492 specifies a detector of its own and it’s tested the same way.
