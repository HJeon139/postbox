# Critique

Two checks, kept apart so neither anchors the other: the floor, which you check on the rendered visual, and the takeaway test, which a reader who has seen only the picture runs. Then a short report and one question to the person.

## The floor

Check each line on a screenshot at the size the visual is read (1000 × 680 by default, and 375 wide). The id in brackets is the house rule or check it comes from; a detector can take over the lines marked *countable*.

**Verify**

- The title states the idea from the brief, as a claim [VE1].
- At 1000 × 680, before any scrolling, the title and every part the idea depends on are on screen, and no label is under 12 px [VE8] *countable: the first viewport’s bounding box and label sizes*.
- Where the outcome comes from steps that add up, one step is drawn, and how steps combine [VE9].
- Each relation in the brief’s “must show” is something you can point at [brief].
- Every label sits on or beside the part it names, in three words or fewer [VE3] *countable: words per shape*.
- The point is the most salient thing: biggest, darkest or the only saturated color. Context is muted.
- Every number in the picture is one of the brief’s facts, or is labeled as invented [VE4].
- Text is at least 12 px and reads against its background [Postbox’s app check].
- One line under each view says how to read it.

**Refuse**

- Sentences inside shapes [VE3] *countable: any shape with more than about six words*.
- A layout that would lose nothing as a table [VE5].
- Several panels or cards of equal weight, with nothing saying where to look first.
- Values shown as numbers in cards where a mark could show them.
- Color that varies without meaning, or a legend the reader must look up when the label could sit on the mark.
- A form the shape table refuses for this shape, such as a ring that puts unrelated things side by side [VE2].
- Motion where nothing in the subject changes over time [VE6].
- More than about 12 parts in one view [VE7] *countable*.

## The takeaway test

The test the whole skill serves: does a reader who sees only the picture get the idea?

1. Take a screenshot of the visual as the person will first see it.
2. Give it to a reader who hasn’t seen the brief or the conversation: a subagent in a fresh context when your harness has one, with only the screenshot and this prompt:

   > Here is a picture someone made to explain something. In one or two sentences, what does it tell you? Then: what did you look at first, and what, if anything, was hard to read?

3. Compare the answer with the brief’s idea:
   - **Landed:** the reader stated the idea, in their own words.
   - **Partly:** the reader got the subject or some of the relations, not the idea.
   - **Missed:** the reader described the picture’s parts, or something else.
4. If it didn’t land, change the visual, not the brief, and test again with a fresh reader. Two misses in a row: show the person the brief and the picture, and ask.

Without a subagent, say so in the report: “Takeaway test not run: no separate reader.” Reading your own picture after writing the brief isn’t the test.

## The report

Lead with the result, in this order:

1. **Takeaway:** landed, partly or missed, with the reader’s words quoted.
2. **Floor:** what failed, ranked: P0 the idea doesn’t come through; P1 a fact is wrong or unlabeled as invented; P2 hard to read; P3 polish. For each, the rule id, what you saw and the fix.
3. **What’s invented or unchecked.**

Then one question to the person, last: which fix to make, or whether the idea is the one they wanted.
