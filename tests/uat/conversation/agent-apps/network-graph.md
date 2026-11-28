# Network graphs

The graph helper gives people an overview of directed relations among groups. The Table view gives them the full set of nodes and edges.
1. Open a conversation with a graph app with about 200 nodes across six named groups, directed links and a highlighted cycle. The fixture in `tests/browser/kit-graph.spec.mjs` exercises that size.
2. At 1000 × 680, verify the figure fits vertically and its labels are readable. At 375 px, tab to the graph and scroll sideways.
3. Verify the highlighted cycle uses dashed arrows. Choose Table and verify every node and edge is available, with cycle membership written in the edge rows.
4. Verify the app’s recorded browser check says it passed.
5. Draw the fixture with arrow characters in node IDs from `tests/browser/kit-graph.spec.mjs`. Verify that an ID containing arrows does not give an unrelated edge a highlight or the sharper bend used for a reverse edge.
