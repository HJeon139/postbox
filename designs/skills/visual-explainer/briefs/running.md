# Sleep and running: a pattern hidden by the route

- **Idea:** Across all 120 runs, sleep seems to make no difference to pace. That’s because the well-rested days are the hill days. On each route on its own, every extra hour of sleep is about 17 to 19 seconds a kilometer faster.
- **For:** A runner who logs their sleep and their runs and wants to know whether sleep matters.
- **Question:** Does sleep actually make me run faster?
- **Facts** (from the run’s `runs.csv`: 120 runs, April 2 to September 8, 2026, each with its route, distance, sleep the night before, pace and temperature):
  - All runs together: the correlation between sleep and pace is −0.02, and the fitted slope is flat.
  - River loop, 75 runs, 5 to 8 km, mostly weekdays: correlation −0.90, about 0.29 min/km (17 seconds) faster per extra hour of sleep. Mean sleep 6.6 hours, mean pace 5.46 min/km.
  - Hill circuit, 45 runs, 10 to 14 km, mostly weekends: correlation −0.95, about 0.31 min/km (19 seconds) faster per extra hour. Mean sleep 7.5 hours, mean pace 6.43 min/km.
  - Average pace by sleep band misleads: 5.97 under 6 hours, 5.79 for 6 to 7, 5.71 for 7 to 8, and 5.94 over 8. The best-rested band looks slow because it’s mostly hill runs.
- **Shape:** A relationship between two quantities, with a third (the route) that hides it: a scatter of sleep against pace, colored by route, with a line for each.
- **Must show:** every run placed by its sleep and pace; the two routes told apart; the slope within each route, against the flat cloud of all of them.
- **Traps:** a bar chart of average pace by sleep band, which shows a misleading U; one correlation number for all runs, which says sleep doesn’t matter; pace over time, which hides sleep; ranking runs by pace.
