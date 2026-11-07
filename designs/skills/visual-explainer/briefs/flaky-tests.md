# Flaky tests: where to start

- **Idea:** The tests that fail aren’t the slow ones. Six tests that share a seeded database fixture take 12% of the test time but cause 76% of the failures. The five browser tests take 78% of the time and seldom fail.
- **For:** A developer on a small shop’s codebase whose tests fail at random and take long.
- **Question:** Our tests fail at random and some are slow; where should we start?
- **Facts** (from the run’s `tests.csv`: 30 test files, each with its fixture, its median time and its failures in the last 200 runs):
  - 184 failures in all, across 200 runs.
  - `db-seed` fixture: 6 tests, 4 to 10.5 seconds each, failing 8.5% to 17.5% of runs; 140 failures (76%), 12% of the test time.
  - `browser` fixture: 5 tests, 41 to 81 seconds each, failing 1% to 3% of runs; 21 failures (11%), 78% of the time.
  - `mock-http`: 7 tests, 9 failures. No fixture: 12 tests, 14 failures. Both are fast.
  - The flakiest file is `db/wishlist.test`, 35 failures; the slowest is `e2e/sign-in.test`, 80.7 seconds.
- **Shape:** A relationship between two quantities per item, time and failure rate, grouped by a category: a scatter colored by fixture.
- **Must show:** every test placed by how long it takes and how often it fails; the db-seed tests standing apart as the flaky cluster; that the slow tests are the reliable ones.
- **Traps:** a bar chart of failures, which hides time; two bar charts side by side, which leave the reader to connect them; a cause beyond the data (the fixture is shared; why it fails isn’t in the file).
