# CI times: where the slower runs came from

- **Idea:** CI got about 50 seconds slower in two ways: one test file jumped from about 12 to about 47 seconds at the commit that upgraded the SQLite driver, and the checkout end-to-end test crept up about 15 seconds as features were added. Everything else stayed flat.
- **For:** A developer on a small shop’s codebase who noticed CI is slower.
- **Question:** Our CI got slow over the last month or so; where did the time go?
- **Facts** (from the run’s `ci-runs.csv`, 40 runs, one a day from September 21, 2026, six test files each):
  - A run took 119.4 seconds on average over the first five runs and 169.7 over the last five, up 50.3.
  - `db/orders.test`: about 12 seconds until run 1016, about 47 from run 1017 on. Run 1017 is commit d5116d9, “upgrade sqlite driver to 9.0”, on October 7, 2026.
  - `e2e/checkout.test`: from about 60 to about 75 seconds, a steady climb of roughly 0.45 seconds a run, with no single step.
  - `unit/cart.test`, `unit/auth.test`, `unit/search.test` and `api/items.test` stay within a few percent of where they started.
- **Shape:** Change over time, with a step in one series and a slope in another.
- **Must show:** each file’s time over the runs on one time axis; the step at run 1017 tied to its commit; the slow climb told apart from the step.
- **Traps:** one total line, which hides which file; a bar of averages, which hides when; a table of 240 rows; a claim about why the driver is slower, which the data doesn’t say.
- **Data, not a concept:** the right form here is a chart (VE10).
