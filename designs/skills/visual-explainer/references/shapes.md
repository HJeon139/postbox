# Content shapes and their forms

Name the shape from the facts. The shape decides which forms can carry the idea, because a form is only as good as what its positions mean: in a diagram, where a thing sits and what it sits next to should tell the reader something they would otherwise have to read ([Larkin & Simon 1987](https://mechanism.ucsd.edu/bill/teaching/F12/cs200/Readings/larkin.whyadiagramissometimesworth.1987.pdf)). A form whose layout means nothing is text in boxes, however it looks.

| Shape | You can tell it by | Forms that carry it | What position means | Refuse |
|---|---|---|---|---|
| **Flow** | Things move from sources to destinations, and amounts matter. | Sankey; flow map; paths that split and merge | Left to right is the direction of travel; width is the amount | Boxes in a row with sentences in them |
| **Cycle** | The end feeds the start again. | A loop with the stages on it; a ring with arrows | Order around the loop is the order of events | A straight line that hides the return |
| **Mechanism** | Parts act on each other to produce an effect. | A labeled cutaway or exploded view; a schematic with the parts in their real arrangement | Where a part sits is where it is, or where it acts | A list of parts; boxes named after the parts |
| **Process with branches** | Steps in order, with decisions that send things different ways. | A flowchart with a few decision points; swimlanes when different actors own steps | Down or across is the order; lanes are who does it | More than about 12 steps in one view; lists inside steps |
| **Change over time** | A quantity rises, falls or diverges. | Line chart; slope chart; small multiples at a few moments | Horizontal is time; height is the amount | Animation in place of an axis; a table of years |
| **Comparison** | Two or more things measured the same way. | Bar or dot chart on one scale; small multiples; a before and after | Position on a shared scale is the value | Numbers in cards; pie charts with many slices; areas the eye can’t compare |
| **Uncertainty** | An estimate with a range. | Interval or band; dots for individual outcomes | Width of the band is how unsure | A single number with no range |
| **Space** | Where things are matters. | A map or a plan, with the data on it | Position is location | A table of places |
| **Hierarchy** | Things contain other things. | A tree; nested areas (treemap) when sizes matter | Inside or below is “part of” | Indented text in boxes |
| **Network** | Many-to-many relations. | Node-link with few nodes; an adjacency matrix when there are many | Lines are real relations; nearness is how close they are | A ring layout that puts unrelated things side by side |
| **Mix of a few poles** | Every outcome is a blend of the same two or three components, and order doesn’t matter. | A ternary (triangle) plot, with each outcome a point; a line segment between two poles | Distance to a corner is how much of that component; corners are the pure cases | A ring or tree of every combination, which puts unrelated outcomes side by side |
| **Trade-off** | Moving one setting improves one thing and worsens another. | One control driving linked views; a curve of one against the other | The curve is the trade-off; a dot is the current setting | Several sliders and no picture of what they trade |

When two shapes fit, the brief has two ideas. Make one visual per idea, or pick the one the question asks about.

## In Postbox

- `postbox.load("d3")` draws any of these. The [d3 gallery](https://observablehq.com/@d3/gallery) shows a working example of most rows; the [FT Visual Vocabulary](https://github.com/Financial-Times/chart-doctor/tree/main/visual-vocabulary) is a chooser by relationship.
- `postbox.charts.line`, `scatter`, `stacked`, `heatmap` and `table` cover the standard charts, each with a table view.
- `postbox.load("katex")` for math in labels; never leave raw TeX in a picture.

## Draw it so the shape shows

- Draw at the size it will be read. A wide figure scaled down to fit shrinks its labels below reading size.
- Color encodes one thing: a category (distinct hues) or an order (one hue, light to dark). Saturate only what the idea is about; leave context gray.
- One main picture per view. Several panels of equal weight leave the reader without a place to start.
