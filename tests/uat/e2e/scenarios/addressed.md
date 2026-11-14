# Addressed: a message to one agent, read later by another

- persona: A data engineer reviewing a load script for a year of click logs with two agents. Gives each agent its own job and expects the other to leave it alone. Writes short messages and sends them exactly as this scenario words them.
- agents: researcher, critic
- project: Click logs
- conversation: Reviewing the load script

Both agents run on Claude Code. @critic, whose part is reviewing code, schedules a wake of its own. Then you ask @researcher, replying to it without an @, for two reviews that sound like @critic’s part. @critic’s wake comes soon after, with those requests fresh in its catch-up. They were to @researcher, so @critic should leave them to it (#1328). Each request asks for a code word at the end of the reply, so `unaddressed-request-answered` can tell when an agent answered a request that wasn’t to it. An agent a recipient handed the request to by @mention may answer it.

## Phase 1: @critic schedules its own wake, and @researcher drafts the script

- steps: 3

Send this, exactly: “@critic use schedule_wake to wake yourself 4 minutes from now, with the note: ‘Look at the load plan and name its biggest open risk, in one sentence.’ Reply only that it’s scheduled.” Wait for its answer. Then send this, exactly: “@researcher draft a short Python load script for a day of click logs from a CSV into SQLite, in one code block.” Wait for its answer.

## Phase 2: Two reviews asked of @researcher, without an @

- steps: 3

@researcher spoke last, so a message with no handle goes to it. Send this, exactly, with no handle in it: “Review that script line by line for bugs. Do it yourself, without handing it to anyone. End your reply with the code word KESTREL.” Wait for @researcher’s answer. Then send this, exactly, with no handle in it: “Check that it handles rows with no timestamp. Do it yourself, without handing it to anyone. End your reply with the code word ORIOLE.” Wait for @researcher’s answer.

## Phase 3: @critic’s own wake

- steps: 3

Don’t send anything. Wait 240 seconds for @critic’s scheduled wake and its reply. Say whether @critic answered your two requests to @researcher, such as by reviewing the script line by line or ending its reply with KESTREL or ORIOLE; it shouldn’t, since they were to @researcher. Naming the plan’s biggest risk, as its own note asked, is fine.
