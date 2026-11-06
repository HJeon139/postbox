# Critique

Two checks, kept apart so neither anchors the other: the floor, which you check on the rendered visual, and the takeaway test, which a reader who has seen only the picture runs. Then a short report and one question to the person.

## The floor

Check each line on a screenshot at the size the visual is read (1000 × 680 by default, and 375 wide). The id in brackets is the house rule or check it comes from; a detector can take over the lines marked *countable*.

**Verify**

- The title states the idea from the brief, as a claim [VE1].
- At 1000 × 680, before any scrolling, the title and every part the idea depends on are on screen, and no label is under 12 px [VE8] *countable: the first viewport’s bounding box and label sizes*.
- Where the outcome comes from steps that add up, one step is drawn, and how steps combine [VE9].
- The parts are drawn as what they are or do (icons, small drawings, a cutaway, marks that carry values), not as boxes holding their names [VE10] *countable: share of text sitting inside rectangles*.
- Where the idea is a relationship between variables, one control changes a variable it turns on, and the picture shows what moves with it [VE11].
- Each relation in the brief’s “must show” is something you can point at [brief].
- Every label sits on or beside the part it names, in three words or fewer [VE3] *countable: words per shape*.
- The point is the most salient thing: biggest, darkest or the only saturated color. Context is muted.
- Every number in the picture is one of the brief’s facts, or is labeled as invented [VE4].
- Text is at least 12 px, has contrast of 4.5:1 or more, and no label overlaps another or is cut off [VE12, Postbox’s app check] *countable: measure from the page’s elements, not from a screenshot; vision models catch overlap only 58 to 78% of the time ([Rahmanzadehgervi et al. 2024](https://arxiv.org/abs/2407.06581))*.
- One line under each view says how to read it.

**Refuse**

- Sentences inside shapes [VE3] *countable: any shape with more than about six words*.
- Labeled boxes joined by arrows as the main picture, a Mermaid flowchart included [VE10].
- A chart of one fixed answer where the idea is a relationship between variables [VE11].
- Raw TeX, low contrast or overlapping text anywhere in the first view [VE12].
- A layout that would lose nothing as a table [VE5].
- Several panels or cards of equal weight, with nothing saying where to look first.
- Values shown as numbers in cards where a mark could show them.
- Color that varies without meaning, or a legend the reader must look up when the label could sit on the mark.
- A form the shape table refuses for this shape, such as a ring that puts unrelated things side by side [VE2].
- Motion where nothing in the subject changes over time [VE6].
- More than about 12 parts in one view [VE7] *countable*.

## The takeaway test

The test the whole skill serves: does a reader who sees only the picture get the idea?

1. Take two screenshots of the visual as the person will first see it: one as it is, and one with every run of text longer than three words hidden (the title, captions, paragraphs and summary boxes), leaving labels. Hide them in the page before the screenshot, for example by setting `visibility: hidden` on each text element of more than three words, so the layout doesn’t move. The second is the one that counts: a headline that states the idea lets a reader repeat it while the picture carries nothing.
2. Give each to a different reader who hasn’t seen the brief or the conversation: a subagent in a fresh context when your harness has one, with only that screenshot and this prompt:

   > Here is a picture someone made to explain something. In one or two sentences, what does it tell you? Then: what did you look at first, and what, if anything, was hard to read?

3. Compare the text-hidden reader’s answer with the brief’s idea (the other reader’s answer is for what was hard to read):
   - **Landed:** the reader stated the idea, in their own words.
   - **Partly:** the reader got the subject or some of the relations, not the idea.
   - **Missed:** the reader described the picture’s parts, or something else.
4. If it didn’t land, change the visual, not the brief, and test again with a fresh reader. Two misses in a row: show the person the brief and the picture, and ask.

**How far to trust it.** On November 6, 2026 the maintainer judged 20 visuals blind and compared them with this test’s grades (then run on the full screenshot only). They agreed exactly on 8 and within one step on 15, a quadratic weighted κ of 0.27, where people agree with each other at about 0.45 to 0.6 on figures ([Design2Code](https://arxiv.org/abs/2403.03163), [PPTAgent](https://arxiv.org/abs/2501.03936)). The test was more lenient on 9 of the 20: it passed visuals whose words stated the idea, and it didn’t see text in boxes, missing relationships or unreadable labels. Hence the text-hidden screenshot and the floor’s VE10 to VE12 lines. Until it agrees with a person about as well as people agree with each other, it informs the person’s judgment and doesn’t replace it.

Without a subagent, say so in the report: “Takeaway test not run: no separate reader.” Reading your own picture after writing the brief isn’t the test.

## The report

Lead with the result, in this order:

1. **Takeaway:** landed, partly or missed, with the reader’s words quoted.
2. **Floor:** what failed, ranked: P0 the idea doesn’t come through; P1 a fact is wrong or unlabeled as invented; P2 hard to read; P3 polish. For each, the rule id, what you saw and the fix.
3. **What’s invented or unchecked.**

Then one question to the person, last: which fix to make, or whether the idea is the one they wanted.
