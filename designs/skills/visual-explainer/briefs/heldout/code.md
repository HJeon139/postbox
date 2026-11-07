# Reminders: why a customer gets the same text twice

- **Idea:** A reminder job is leased to a worker for 60 seconds, but a text may take up to 90. When a send runs past the lease, the sweeper puts the job back, the other worker claims it and sends it again, and both mark it done; nothing checks who still holds the job. Retries after a failure aren’t the cause.
- **For:** The one developer who looks after a small grooming shop’s reminder texts, after customers got the same text twice.
- **Question:** How does a reminder get from a booking to a text, and how could it go out twice?
- **Facts** (from the run’s `src/`, about 180 lines, and `logs/worker.log`, simulated from that code with its constants by `make-code-log.mjs`, seed 4419):
  - `bookings.mjs`: one job per booking, due 24 hours before it; a booking that already has a job is skipped, so scheduling can’t make a second one.
  - `worker.mjs`: two workers; an idle one looks for a job every 2 seconds. `jobs.mjs`, `claim`: the first queued job that’s due becomes running, leased to that worker for 60 seconds, and its attempt count goes up.
  - `handlers/send-reminder.mjs`: a canceled booking or one already started is done without a text; otherwise it sends through `sms.mjs`, which gives up after 90 seconds.
  - After a send, `complete` marks the job done without checking its owner. After a failure, `fail` queues it again after 30 s, 1, 2 and 4 minutes (`backoff.mjs`), and the fifth failure makes it dead.
  - `sweeper.mjs`: every 15 seconds, any running job whose lease ran out goes back to queued, due at once.
  - Last week’s log: 64 bookings, 2 canceled and skipped, 65 texts for 62 bookings. Three bookings got two texts; in each, the first send took 79 to 83 seconds and the second worker claimed the job at the next sweep after the lease ran out, sending again within 2 seconds.
  - Six sends took over 60 seconds. The three that didn’t double finished before another worker claimed the job: the slowest, 75.6 seconds, finished 0.75 seconds after the sweeper had put it back. No send failed all week, so no retry ran.
- **Shape:** A mechanism with a loop: a job’s states (queued, running, done, dead) with the routes between them, two workers acting on the same job, and the race between a slow send and the lease running out.
- **Must show:** the route of one reminder from booking to done, with the skips and the retry loop; the sweeper’s route from running back to queued; two workers on one job when a send outlasts its lease; that the 60-second lease is shorter than the 90-second send limit.
- **Traps:** a box per file with arrows for the imports, which is the code’s layout, not what happens; a straight pipeline with no loop back; blaming retries or scheduling, which the code and the log rule out; a bar chart of send times or a ranking of slow sends, which shows that sends are slow but not why that doubles them.
