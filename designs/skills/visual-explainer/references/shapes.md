# Content shapes and their forms

Name the shape from the facts. The shape decides which forms can carry the idea, because a form is only as good as what its positions mean: in a diagram, where a thing sits and what it sits next to should tell the reader something they would otherwise have to read ([Larkin & Simon 1987](https://mechanism.ucsd.edu/bill/teaching/F12/cs200/Readings/larkin.whyadiagramissometimesworth.1987.pdf)). A form whose layout means nothing is text in boxes, however it looks.

| Shape | You can tell it by | Forms that carry it | What position means | Refuse |
|---|---|---|---|---|
| **Flow** | Things move from sources to destinations, and amounts matter. | Sankey; flow map; paths that split and merge | Left to right is the direction of travel; width is the amount | Boxes in a row with sentences in them |
| **Cycle** | The end feeds the start again. | A loop with the stages on it; a ring with arrows | Order around the loop is the order of events | A straight line that hides the return |
| **Mechanism** | Parts act on each other to produce an effect. | A labeled cutaway or exploded view; a schematic with the parts in their real arrangement | Where a part sits is where it is, or where it acts | A list of parts; boxes named after the parts |
| **Process with branches** | Steps in order, with decisions that send things different ways. | A drawn route, such as a road, a board game or a pipeline, with each step as an icon and each decision as a fork; lanes when different actors own steps | Along the route is the order; lanes are who does it; a fork is a decision | Labeled boxes and arrows, a Mermaid flowchart included; more than about 12 steps in one view; lists inside steps |
| **Change over time** | A quantity rises, falls or diverges. | Line chart; slope chart; small multiples at a few moments | Horizontal is time; height is the amount | Animation in place of an axis; a table of years |
| **Comparison** | Two or more things measured the same way. | Bar or dot chart on one scale; small multiples; a before and after | Position on a shared scale is the value | Numbers in cards; pie charts with many slices; areas the eye can’t compare |
| **Uncertainty** | An estimate with a range. | Interval or band; dots for individual outcomes | Width of the band is how unsure | A single number with no range |
| **Space** | Where things are matters. | A map or a plan, with the data on it | Position is location | A table of places |
| **Hierarchy** | Things contain other things. | A tree; nested areas (treemap) when sizes matter | Inside or below is “part of” | Indented text in boxes |
| **Network** | Many-to-many relations. | Node-link with few nodes, each drawn as what it is (an icon or a small picture); an adjacency matrix when there are many | Lines are real relations; nearness is how close they are | A ring layout that puts unrelated things side by side |
| **Mix of a few poles** | Every outcome is a blend of the same two or three components, and order doesn’t matter. | A ternary (triangle) plot, with each outcome a point; a line segment between two poles | Distance to a corner is how much of that component; corners are the pure cases | A ring or tree of every combination, which puts unrelated outcomes side by side |
| **Trade-off** | Moving one setting improves one thing and worsens another. | One control driving linked views; a curve of one against the other | The curve is the trade-off; a dot is the current setting | Several sliders and no picture of what they trade |

When two shapes fit, the brief has two ideas. Make one visual per idea, or pick the one the question asks about.

## What good looks like

From the maintainer’s blind verdicts on 20 agent-made visuals (November 6, 2026), the visuals that landed had these in common, and the ones that missed lacked them:
- **Drawn, not boxed.** Infographics and textbook illustrations, not labeled boxes (VE10). References the maintainer pointed to: an illustrated “How a bill becomes law” poster by Quarterhouse (an [Etsy listing](https://www.etsy.com/listing/1425377994/quarterhouse-illustrated-how-a-bill), which may not last: the point is an illustrated poster of the process rather than a flowchart), a [Krebs cycle infographic](https://praxilabs.com/en/blog/2023/01/02/krebs-cycle/), and an engineering teardown, where every part is drawn in place with a short label. Drawn includes charts: where the facts are numbers, a plain chart whose marks carry them is the form, and the compound-interest chart with a rate control was marked landed. What failed in a chart was a fixed answer or two views doing one job, not being a chart.
- **Relationships you can move.** Where the idea is how one thing depends on another, one control for a variable the idea turns on, with every view that depends on it moving together, and, where it helps, a question to predict that sits beside the picture and never hides it (VE11).
- **Values carried by the marks.** Size, position and change over time encode the numbers; text only names them.
- **One idea, cleanly.** “Mostly there” meant too much at once: cut to the one idea and fit the screen (VE7, VE8).
- **Readable.** Low contrast, overlapping labels or raw TeX turned an otherwise good visual into a miss (VE12).

## In Postbox

- `postbox.load("d3")` draws any of these. The [d3 gallery](https://observablehq.com/@d3/gallery) shows a working example of most rows; the [FT Visual Vocabulary](https://github.com/Financial-Times/chart-doctor/tree/main/visual-vocabulary) is a chooser by relationship.
- `postbox.charts.line`, `scatter`, `stacked`, `heatmap` and `table` cover the standard charts, each with a table view.
- `postbox.load("katex")` for math in labels; never leave raw TeX in a picture.

## Draw it so the shape shows

- Draw at the size it will be read. A wide figure scaled down to fit shrinks its labels below reading size.
- Color encodes one thing: a category (distinct hues) or an order (one hue, light to dark). Saturate only what the idea is about; leave context gray.
- One main picture per view. Several panels of equal weight leave the reader without a place to start.
