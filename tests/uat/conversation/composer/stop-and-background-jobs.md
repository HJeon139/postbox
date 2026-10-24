# Stop, and background jobs

**Where:** Above the composer (Stop’s ask), and under an agent’s reply (its background jobs).

## Why it exists

Stop has to end the agent’s turn for real. Before #126, Stop marked the turn stopped but left the CLI running, so the next turn ran beside the old one in the same session, and the old turn’s tool calls showed up as the new turn’s. Now the session reads “stopping” until its process has exited, its next turn waits for that, and a stopped turn’s tool calls are refused.

An agent can start a command in the background (Bash with `run_in_background`, a Bash call Claude Code moves to the background at its timeout, or a `Monitor` watch), such as a 30-minute UAT run that spends money (#129). Its tool call returns at once, so its step used to read “done” while the command ran on, and nothing in the room showed it. Stopping the agent stops those jobs too, so Stop asks first: you may want the agent to stop and its job to finish.
- **The job row** shows each background job that’s still running, outside the folded activity list, so you see it without opening anything. Its **Stop** stops that job alone.
- **The ask** is a choice you make there and then, so it’s a quiet row above the composer, not a card. Only its first choice is amber.

## Expected functionality

- While a background job runs, its reply shows “Background job · <what it runs>” with a Stop button. The glyph holds still, in the quiet color. In the folded activity list, its step says “Running in the background”.
- Stop, with a job running, asks “@developer has 1 background job running. Stop it too?” with **Stop it too**, **Keep running**, and an × (Don’t stop). Focus moves to Stop it too. Nothing stops until you answer.
  - Escape, or ×, closes the ask; the agent carries on, and focus goes back to Stop.
  - **Stop it too** stops the agent and its jobs. Their steps read “Stopped”.
  - **Keep running** stops the agent; its jobs keep running, still listed with their own Stop, and the reply reads “Stopped by you at hh:mm · its background work kept running” (#249). The agent’s next turn is told the job is still running, that you stopped the turn but kept the job, that its CLI may say the job was stopped though it wasn’t, and where its output is, and to leave a progress step that follows it running. The progress steps that were running when you chose Keep running stay running, not stalled, while a job you kept runs on; a step a later turn leaves running stalls as usual. When the last kept job ends, those steps read as stalled, and the agent’s next turn is told to close them. Postbox never kills a job you kept (#164):
    - When it can’t tell which of the agent’s processes is the job, it keeps them all running. The job row says “Postbox couldn’t tell which of 2 processes is this job, so it kept them all running; stopping the job stops them all.”, the agent hears the same, and the job’s Stop stops them all ([screenshot](../../screenshots/kept-job-unsure.png)).
    - Two such jobs in one turn are kept with the same processes, so stopping either stops both. The other one’s step reads “Stopped: Postbox couldn’t tell its processes from those of the background job “…”, so stopping that job stopped this one too.”, never “done” (#167).
    - When the job has no process left to keep, its step reads “Stopped: Postbox couldn’t find its process to keep it running: it may have ended with the agent, and Postbox can’t show it or stop it.”
- Stop with no background job running stops at once, without asking.
- **Send now** (or a message sent with Send now from the queue) stops the agent without asking, and keeps its jobs running. The reply it interrupted reads “Interrupted by Send now at hh:mm”, not “Stopped by you” (#215), and the agent hears that Send now ended its turn but not its jobs.
- After Stop, the agent reads “· stopping” beside its name until its process has exited, usually within a second or two, then “Stopped by you”. A message you send meanwhile appears at once and the agent starts on it when the old process has gone.
- A job’s own Stop stops it; its step reads “Stopped”, and the agent hears about it on its next turn.

## Steps to reproduce

Automated: `node tools/check-stop.mjs` (headless Chrome, a scripted agent, no real processes). `PB_SHOT=tests/uat/screenshots/kept-job-unsure.png node tools/check-stop.mjs` retakes the screenshot.

With a real agent:
1. Run Postbox with real agents (`node server/index.mjs --port 4181 --data /tmp/pb-uat-real --fresh`) and open <http://127.0.0.1:4181/>.
2. Give a Claude Code agent the Shell tool. Ask it: “Use the Bash tool with run_in_background set to true to run exactly: sleep 300; echo done. Then reply started.”
3. Check the job row appears under its reply, with Stop.
4. Press Stop in the composer. Check the ask, then press Escape: the agent is still working.
5. Press Stop again and choose Keep running. Check the agent reads “stopping”, then “Stopped by you”, the reply reads “Stopped by you at hh:mm · its background work kept running”, and the job row stays. Ask the agent whether the job is still running: it should say it is. In a terminal, `ps axo pid,ppid,pgid,command | grep 'sleep 300'` still lists it.
6. Press the job row’s Stop. Check the row goes, the step reads “Stopped”, and `ps` no longer lists it.
7. Repeat steps 2 to 4, and choose Stop it too. Check the job row goes, and `ps` lists neither the CLI nor the job.
8. Ask it: “Use the Bash tool with run_in_background set to true to run exactly: cd /tmp && for i in $(seq 1 60); do date >> pbx-heartbeat.log; sleep 5; done. Then wait for it with the Bash tool: sleep 120.” While it waits, press Stop and choose Keep running. Check the job row stays, and `tail -f /tmp/pbx-heartbeat.log` keeps growing (#164: Claude Code runs the job without its `cd`, which Postbox once failed to match, and killed). Then press the job row’s Stop.

9. Repeat step 2, and while the agent works, send “Reply with one line of status.” and choose Send now on it in the queue. Check the interrupted reply reads “Interrupted by Send now at hh:mm”, the job row stays, and the agent’s answer says the job is still running. Then press the job row’s Stop.

**Pass if:** every step behaves as described, and after each Stop no `claude -p` process of that agent is left running.
