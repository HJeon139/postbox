# Reminders

Texts each customer of Tidy Tails Grooming the day before their booking. `npm start` reads the bookings in `data/bookings.json` every hour and runs two workers over the jobs in `data/jobs.json`.
- Set `SMS_URL` to the text provider’s endpoint to send for real. Without it, texts go to `data/outbox.log`.
- `logs/worker.log` is last week’s log from the shop’s machine.
