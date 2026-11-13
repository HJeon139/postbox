# Changelog

Every release of Postbox, newest first. Written by `npm run release` from the commits since the last one.

## 4.5.0 (2026-11-13)

### Features

- **settings:** list the boilerplates under Settings › Personas

### Fixes

- **settings:** leave Blank out of the boilerplate row
- **seed:** give the Blank boilerplate no description, so none is saved
- **tests:** the #208 persona delete test waits for the memory folder it checks
- **tests:** the until() tests move a mock clock instead of stalling
- **tests:** the fake daemon reader's deadline test holds however slow the runner
- **sheets:** start the New agent sheet on Blank
- **sheets:** say a fresh install has no project, not “undefined”, in New agent
- **seed:** drop the Indexer boilerplate left from the demo's corpus

## 4.4.0 (2026-11-13)

### Features

- **seed:** add a scrum master boilerplate grounded in the agile manifesto

### Fixes

- **personas:** keep the scrum master's sprint board in a table block

## 4.3.1 (2026-11-12)

### Fixes

- **server:** a chain limit set on a conversation started behind a held commit lands on it
- **server:** a delete looks everything up, pending, before it changes anything
- **tests:** the fake daemon reader waits 10 s for a turn to start
- **tests:** the cleanup and broker daemon tests wait for the close before removing the home
- **tests:** the Codex restart test waits for the first broker's close
- **tests:** the daemon tests' done() waits for the close before it removes the home
- **tests:** the fake daemon reader waits 2 s and looks once more at its deadline
- **tests:** the broker close-after tests wait for the shim's answer, not 50 ms
- **server:** close() clears timers again after the hosts stop, and its ledger wait is tested
- **server:** changing or deleting an agent made behind a held commit works
- **tests:** other polling waits look once more before they give up
- **tests:** the remote read tests wait the default 2 s for a socket round trip
- **tests:** until() looks once more at its deadline before it throws
- **server:** the work ledger's records of stopped turns land before the store closes
- **server:** a closed Postbox starts no turn: close() clears every timer the runtime started
- **server:** a fresh start empties the asset folder too
- **server:** a 500's log line takes the request's path as an argument
- **server:** an agent joining behind a held commit is found, and attach follows it
- **server:** a route that answers with nothing gets a 500 that names it
- **server:** renaming a conversation deleted behind a held commit is refused
- **server:** a conversation started behind a held commit returns its thread

## 4.3.0 (2026-11-12)

### Features

- **demo:** replay five real recorded sessions as the demo's showcase story

### Fixes

- **demo:** the showcase spec reads v2's frame without holding an element across a redraw
- **demo:** the replay writes its app file under the room's folder as named, and never a folder

## 4.2.0 (2026-11-12)

### Features

- **server:** a thought shows while the agent writes it, its text so far, then whole
- **app:** a running turn's thoughts show whole between its steps
- **app:** a running turn's steps show live between its words, and fold into its work record
- **server:** a step keeps an edit's change and where it fell in the reply's words
- a running turn's steps show open, with each call's input and output

### Fixes

- **app:** a crowded agent's working row shows while its running reply is off screen
- **app:** a crowded room's agents have no working row, which their replies already say
- **app:** "Show the whole thought" leaves focus on the thought it opened
- **app:** a long answer doesn't draw words twice, and ten agents' running replies fit
- **app:** an opened work record's edits show their counts, as the live view's lines did
- **app:** running replies fit the screen, their words, thoughts and working rows counted
- **app:** the list under a finished post doesn't repeat the calls its work record lists
- **app:** an agent's working row doesn't say again the thought its live reply shows
- **app:** a running turn's step paints its live block, not the whole reply
- **server:** a stopped turn's steps fold, and so do those of a turn a restart cut off
- **uat:** agents-section-members reads the Agents section's rows by their names again
- **app:** Work shows no spend for an agent whose harness reports none, not $0.00
- **server:** a step's input leaves out what its label already says
- **adapters:** a failed Antigravity command reads as failed, after the times 1.5.5 adds
- **app:** a running turn's thoughts are set apart from its words, in italic beside a rule
- **app:** only a running turn's newest call shows in full, in whichever part of its reply it fell
- **app:** a finished turn's record sits with its words, not above other agents' posts
- **server:** a finished turn's steps fold to what its record keeps
- **adapters:** a Codex edit shows its diff and counts, from the patch its stream carries
- **app:** a finished turn's line shows once, in its work record
- a post below a running reply no longer breaks its steps from its words
- **app:** the newest edit shows its diff, not its input and its "ok" again
- **app:** a finished turn's steps fold unless the person opened them
- **adapters:** Antigravity's and Kiro's tool-schema loads stay out of Work
- **server:** a long path in a step's input is cut in its middle, keeping the file name
- **server:** a step's input and output are bounded in one place, keeping the cut mark
- **adapters:** Kiro's file writes, edits and commands reach Work
- **adapters:** Antigravity's ring keeps the last step's context when the turn ends
- **app:** a step says its command and why it failed once each
- **server:** a step's output, cut to its end, starts at a whole line and says it was cut
- **adapters:** a failed Codex command says why, from what it printed

## 4.1.0 (2026-11-12)

### Features

- **uat:** add turn-after-delete, the live half of the removed delete check

### Fixes

- **uat:** wait for a deleted conversation to go, not for its undo window

## 4.0.8 (2026-11-12)

### Fixes

- **view:** keep a redrawn item drawn when the one it replaces was
- **view:** let go of an item held drawn once it has left the page
- **server:** Send now on a queued wake returns a body, as the route sends it
- **server:** answering a wake card returns a body, so the act route doesn't throw

## 4.0.7 (2026-11-11)

### Fixes

- **view:** anchor on the first reply in view when the middle one is skipped

## 4.0.6 (2026-11-11)

### Fixes

- **ranges:** an item moved forward while you read at the top shows its stub, and End puts it last
- **ranges:** keep the items around each open ask, so ⌃J and the open-asks link load nothing
- **window:** a range that replaces another keeps its kinds' height estimates
- **view:** a rebuild placed short of the end to go to an item stops following the end
- **app:** End after Home puts the newest range back with no load, as main does
- **app:** a long room's first range comes with the load that opens it, for Home at any moment
- **app:** a transcript window built on the page paints its spacers once, and Home does main's work
- **app:** the three conversations you left last stay warm, so going back loads nothing, as on main
- **app:** a load past an edge, queued behind a reload, is for the range the page holds when it runs
- **app:** Home with focus in the transcript goes to the room's first item in one press
- **app:** Home in a long room is as quick as on main: its first items are kept from when it opened
- **app:** a conversation the page hasn't loaded opens once its items land, drawn once
- **app:** a resync with the transcript window off loads each open conversation once, whole
- **app:** switching conversations reconnects the stream without it reading as a connection change
- **server:** the stream builds a cursor form only for an item's event, as other events cost on main
- **server:** an event the page may not see sends no header frame after its cursor
- **server:** one request to the items route can't hold the server: limit=all and searches are capped
- **app:** a move counts toward a conversation's length, so an add heard after it is kept
- **app:** an event heard during a scroll load reaches the item the load brings
- **app:** a load from an earlier opening of a conversation leaves the newer range as it is
- **server:** a held-back stream frame says what its event said, not what the store holds by then
- **app:** deleting a conversation goes to its project once the page has heard it's gone
- **tools:** the doc-query probe counts the open room's items from its header
- **app:** Home loads a conversation's first items and End its latest, past what the page holds
- **app:** a message added past what's loaded counts on the pill and is heard as it streams
- **app:** an item with focus keeps it when a range lands and the transcript is drawn again
- **app:** a conversation view drawn again keeps its items and the focus in it
- **app:** the page loads no items of a conversation deleted while a load waited
- **tools:** the demo tour reads each conversation's items from its items route
- **app:** view_app's capture page asks the server for the app's item
- **server:** a session that needed you before needsAt gets its item's time as the store loads
- **server:** /api/state has no items, and a page's stream sends item events only for open rooms
- **app:** search asks the server, so it finds items the page hasn't loaded
- **app:** a jump to an item the page hasn't loaded loads the range around it first
- **app:** the page loads a conversation's items when it opens it, and the next range as you scroll

## 4.0.5 (2026-11-11)

### Fixes

- **view:** hold the anchor's place, and publish where it is apart from it
- **view:** publish where a hold of the anchor landed, not where it aimed

## 4.0.4 (2026-11-11)

### Fixes

- **uat:** don't count a view sample as settled while its jump to the end runs
- **view:** say a jump to the end is still running, and wait for it before reading the page

## 4.0.3 (2026-11-11)

### Fixes

- **uat:** fail a run whose Postbox prints an error or a warning, or crashes
- **uat:** keep what the run's Postbox prints, and its own exits, in the run's facts
- **server:** the persona sheet's skills read a session's / menu as it's stored

## 4.0.2 (2026-11-11)

### Fixes

- **app:** Enter right after typing in Jump to… acts on that query, and a status says what it found
- **app:** one search in the top bar: Jump to… also finds the open conversation's messages

## 4.0.1 (2026-11-11)

### Fixes

- **app:** the element budget doesn't unmount what a scroll just mounted
- **server:** a session keeps its need's item time, so ⌃J orders without the conversation's items
- **server:** thread headers update from each event, and a frame goes out only when one changed
- **app:** the page reads each thread's header facts, not its items, across conversations
- **app:** the transcript window budgets elements on the page, not only items

## 4.0.0 (2026-11-11)

### Breaking changes

- **agents:** an agent's name opens its persona sheet; actions are @agent commands
- **settings:** every persona change applies from the agent's next turn
- **delete:** delete is just delete, with no Undo window

### Features

- **settings:** the persona sheet offers Auto (the harness judges) and Run everything

### Fixes

- **permissions:** a persona runs Auto or Run everything, whatever it was stored as
- **settings:** drop ranWith and settingsAt, which nothing read
- **permissions:** only the persona sheet changes the mode, and never mid-turn
- **settings:** the sheet shows and saves Ask me and Accept edits as Auto

## 3.0.1 (2026-11-11)

### Fixes

- **server:** a range's limit is a whole number of items
- **server:** a conversation id that isn't valid percent-encoding answers 404, not 500
- **server:** a conversation's items by range and its search, for the page to load just in time

## 3.0.0 (2026-11-11)

### Breaking changes

- telemetry is gone, so nothing here cites it

## 2.0.0 (2026-11-11)

### Breaking changes

- **store:** drop the tool that rewrote a snapshot for a Postbox from before #1180
- **assets:** replace the corpus and datasets with search over room assets
- **store:** every snapshot is lines, and a tool rewrites one for a Postbox from before #1180 (#1180)

### Fixes

- **assets:** fence each passage search_assets gives, as read_asset does
- **app:** an older log's dataset line shows who loaded which, not an empty line
- **assets:** an older log's dataset line no longer says to search it by books
- **assets:** rebuild a room's search index when an asset is renamed
- **telemetry:** leave out tool ids Postbox no longer has from a report
- **uat:** the verifier is told snapshot.json is lines, not one JSON object (#1180)
- **store:** a line snapshot's objects are plain, and fileLines joins a long line once (#1180)
- **store:** emits wait while a snapshot is written, so it's one view of the state (#1180)
- **store:** a line snapshot splits on the newline byte, and ends with a line that counts it (#1180)
- **store:** the snapshot is written as lines and read back by line, as the log is (#1180)

## 1.58.6 (2026-11-11)

### Fixes

- **server:** a live stream whose page hasn't read for a minute is closed (#1210)
- **server:** JSON responses go out as bytes, so a slow page doesn't hold the state on the heap
- **needs:** a refused tool call shows what happened and never needs you
- **blocks:** show a changed block's notice as the change arrives

## 1.58.5 (2026-11-10)

### Fixes

- **composer:** a reconnect starts the outbox's tries again from the quick ones

## 1.58.4 (2026-11-10)

### Fixes

- **uat:** the credential preflight reads the last of every credential helper, site ones too
- **uat:** a git-remote run's git lfs refuses, since it goes around the guard
- **uat:** the preflight checks the credential guard, without running a helper
- **uat:** the agent's env file puts the whole git guard back after its profile
- **uat:** the guard blanks an inherited GIT_CONFIG_PARAMETERS

## 1.58.3 (2026-11-10)

### Fixes

- **backends:** refuse a long agy prompt only when the system does
- **work:** read a background command's output file from the real /tmp too
- **codex:** the failed step gives Codex's own reason, bounded (#1162)
- **codex:** the tools-down note reaches every kind of turn, and skips a command (#1162)
- **remote:** moving an agent off a silent host drains what waited for its attach (#1135)
- **remote:** a message waits for an attach only while the agent still runs on that host (#1135)
- **permissions:** find curl after a subshell, a backtick or a quote
- **permissions:** hide a header value that starts with a digit, and keep ports
- **uat:** a git-remote run blanks the terminal's askpass itself
- **backends:** guard a local Kiro turn's stdin, and say what agy's refusal counted
- **composer:** a send that keeps failing with the stream open goes on being tried, and says so
- **backends:** send Kiro a long prompt on stdin, and refuse one agy can't take
- **work:** read a background command's output file only from the agent's or the backend's folders
- **review:** an old review's outcome reads its off-rule authors as its agent's (#1143)
- **review:** an old review's off-rule author reads as its agent's, so a submit still lands (#1143)
- **codex:** only a listed entry of Codex's failed servers is Postbox's; the note says where (#1162)
- **mock:** the demo's critic replies in the person's threads, not as "You" (#1143)
- **permissions:** hide curl's bundled -u, -U and --proxy-user passwords, and stop two over-cuts
- **review:** a review comment authored @you, in any case, reads as the person's (#1143)
- **review:** refuse a submitted reply in a thread the review doesn't have (#1143)
- **review:** the person's refused submit says what they can do, not to resolve some (#1143)
- **codex:** show when Codex refuses a turn for Postbox's server, and tell the next turn (#1162)
- **review:** tell the agent to resolve the person's threads once it has handled them (#1143)
- **review:** a review comment's author is an agent's @handle or the person's you (#1143)
- **app:** the transcript holds the room below its newest message with its own margin (#1150)
- **remote:** a drain reads one busy rule, busyFor, so it waits for an attach too (#1135)
- **review:** refuse a shown review with a comment in the person's name (#1143)
- **review:** keep the person's submitted comments on the block as threads
- **remote:** a message for an agent whose host turn waits to be attached waits in the queue (#1135)

## 1.58.2 (2026-11-10)

### Fixes

- **adapters:** a path’s links are counted once for the whole walk (#1134)
- **adapters:** a link’s target is walked as written, never trimmed (#1134)
- **adapters:** a dangling link’s target is walked as any path is, through its own links (#1134)
- **adapters:** a dangling link in a path is followed to its target, not kept as written (#1134)

## 1.58.1 (2026-11-10)

### Fixes

- **adapters:** a slash command or re-attach leaves the tools-down note for the next turn (#1161)
- **review:** add comment quotes to the highlight a frame after they're drawn (#1151)
- **review:** the comment highlight is built once, and each review adds only its own marks (#1151)
- **adapters:** show when Postbox's server fails in an init, and tell the agent next turn (#1161)

## 1.58.0 (2026-11-10)

### Features

- **app:** the transcript window is on by default for long conversations (#866)
- **app:** behind the flag, a jump to an item off the page mounts it first (#866, W3)
- **app:** behind the flag, the window unmounts what's furthest from the view (#866, W2)
- **app:** behind a flag, a long conversation mounts only the items around the view (#866, W1)

### Fixes

- **app:** an island follows its redrawn node, and keeps its focus when it rejoins the range (#866)
- **app:** an island moved to the end leaves no stray stub on the page (#866)
- **app:** the window grows just after the frame's layout, so a reply arriving forces none (#1047)
- **app:** a far jump takes the conversation's top from where the spacer sits on the page (#866)
- **app:** a far jump reads the range from its items, leaves other scrollers their keys (#866)
- **app:** the window follows a far scroll, Home, End and Jump to latest, and lets go cleanly (#866)
- **app:** the window tells the view directly, and a rebuild keeps your place and skipping (#866)
- **app:** the window keeps the browser's skipping off, and tells the view when it scrolls (#866)

## 1.57.1 (2026-11-10)

### Fixes

- **server:** export stillThere for its test, and key the cache on nanoseconds
- **review:** drop the oldest kept draft before saving a new one (#1144)
- **work:** a kept background job that ends on its own reads as ended, not unknown (#519)
- **review:** forget a kept draft once its review is answered, and keep at most 20 (#1144)
- **server:** read a served file from the handle that was checked
- **review:** keep the text a review's drafts were written on (#1144)
- **review:** keep a review's draft comments over a reload (#1144)
- **permissions:** a read in a readable folder is judged from the pending session (#1074)
- **adapters:** the agy hook leaves a read in a readable folder to Postbox (#1074)

## 1.57.0 (2026-11-10)

### Features

- **work:** the passes run after each turn and once after start, off until step 4 (#305)
- **work:** the archive pass moves each agent's older ended turns into archive files (#305)

### Fixes

- **app:** the pane's width isn't inherited, so a new width restyles only its readers (#1150)
- **uat:** find the newest Undo toast first, as the stack orders it
- **work:** endedAs sits above endWork's doc comment, not under it (#305)
- **store:** the pending view applies turn.archive and reads its list back (#305)

## 1.56.1 (2026-11-10)

### Fixes

- **kiro:** show when Postbox's tool server fails to start, and tell the agent next turn (#489)
- **server:** a refused mention or summary is posted as a system line (#362)
- **server:** a refused hand-off is posted, and its agent gets one turn to send it
- **server:** mentions and summaries keep the send limit, and wakes cap at 20
- **tests:** the remote rig's work root is a temp folder of its own (#823)
- **adapters:** .git and agy’s settings judge both readings of a path, through realReadings (#1074)
- **permissions:** /mode names the busy agent's own backend, not Claude Code (#1030)
- **adapters:** a path’s .. is judged as text too, so a link can’t hide a climb out (#1074)
- **permissions:** a read card for a path that isn’t text says so, not an empty file_path (#1074)
- **adapters:** a file call naming a ~user path asks, and is refused where it may be agy’s (#1074)
- **permissions:** a read card shows each path on a line of its own, tidied and clipped (#1074)
- **adapters:** Auto’s routine commands judge a path as the hook’s file calls do (#1074)
- **permissions:** a read card names every outside path, and each must be readable (#1074)
- **permissions:** a read card's Always allow says the folder is the agent's
- **permissions:** a folder in home named ..something is a dot-folder, never offered
- **adapters:** agy hook compares readable folders as Postbox saved them
- **adapters:** agy reads its own builtin skills and guide with no card
- **adapters:** agy hook judges a ~ path as the home folder too
- **adapters:** agy hook judges every path a file call names, not only the first
- **adapters:** agy hook follows a link before a .. in a path, as the file system does
- **apps:** load each check frame at its own width, and fire its resize inside the frame
- **permissions:** say why a running turn keeps its mode, and what its hooks do
- **apps:** resize each check frame and change its theme while the app loads
- **tests:** a gate run's tests write temp files only in its own temp folder
- **tests:** an install test's pause ends at a limit, and runs as root

## 1.56.0 (2026-11-10)

### Features

- **app:** the page records keys and clicks 500 ms slow in its lag log (#821)

### Fixes

- **shell:** the shared stack never pushes out the notice it just added (#444)
- **shell:** a live Undo isn't pushed out by an ordinary notice in the shared stack (#444)
- **blocks:** a resolved thread on an answered review leaves it answered (#901)
- **shell:** put delete notices in the shared stack
- **apps:** a send's turn of 5 s starts when it starts, so a slow burst keeps its order (#934)
- **review:** the delimiter row follows the last header row of a diff (#1098)
- **app:** an open item a press closes across a held refill stays closed (#1010)
- **apps:** a send with no answer holds back the next only for its turn of 5 s (#934)
- **apps:** an app's sends go one after another, so they're stored in the order it sent them (#934)
- **app:** a press on the Work pane or the Threads page holds its repaint until it ends
- **review:** number a table's delimiter row in Lines and let it take a comment

## 1.55.3 (2026-11-09)

### Fixes

- **blocks:** a year or id ends the label, or starts it with no amount after (#1065 round 4)
- **blocks:** a singular year or id anywhere names the column, and a silent label defers to the id
- **blocks:** read a year or id column's name past a note or punctuation after it
- **blocks:** keep separators in an amount column over a year or an id

## 1.55.2 (2026-11-09)

### Fixes

- **composer:** a send that failed while the stream is open is sent again shortly (#1126)

## 1.55.1 (2026-11-09)

### Fixes

- **remote:** a background task's stop text uses the shared invisible set and a whole-pair cut

## 1.55.0 (2026-11-09)

### Features

- **uat:** a run's report names each call to GitHub its guard refused

### Fixes

- **uat:** a call counts as an attempt only when one segment of its command runs gh or git
- **uat:** the GitHub line reads gh's and git's own wording, and skips a run with no guard
- **blocks:** a wide table fades the side that has more columns to scroll to

## 1.54.3 (2026-11-09)

### Fixes

- **backends:** clip the backend name in placement's other refusals too
- **permissions:** an Authorization scheme only after a space, and marks in the lookbehinds
- **permissions:** hide a quoted Authorization header's every parameter, and curl -u's password
- **backends:** strip every hiding character from a backend name in a reason
- **permissions:** the hooks panel hides more credential shapes

## 1.54.2 (2026-11-09)

### Fixes

- **apps:** an app's send in an archived conversation is refused before it's recorded (#848)
- **blocks:** an answer in an archived conversation is refused before it's recorded (#848)

## 1.54.1 (2026-11-09)

### Fixes

- **queue:** an API Send now marks a plain Stop’s exit silent too, through one stopForSendNow (#1040)
- **queue:** Send now during a plain Stop’s exit marks the exit silent, so it goes alone (#1040)
- **queue:** after a Stop, the first turn takes its thread's queued wakes (#1040)
- **uat:** a teardown that fails after a failed preflight keeps the preflight's reason
- **uat:** the guard blanks git's askpass, so a terminal's sign-in gives an agent's git no password
- **server:** echoedId cuts with partEnd, so an echoed id never ends on half a pair (#895)
- **server:** cut the ids update_block and retire_app echo in their refusals to 40 characters
- **files:** keep hidesName for the callers that read one character at a time
- **files:** keep only England's, Scotland's and Wales's flags whole
- **files:** stored upload names are cleaned where they're read, and tag flags stay whole
- **blocks:** the reaction count leaves the accessibility tree, and an unproved rule goes (#1068)
- **tests:** flag connector tool ids, keep recordings' plugins public, print no path from the scan
- **work:** a ref line's flag takes its own spaces, so a run of spaces splits one way (#1032)
- **work:** read git push's ref lines with spaces and tabs only, in linear time (#1032)
- **uat:** the git-remote preflight probes outside the workspace, and a failed one removes the remote
- **security:** take every default-ignorable code point and line separator into the invisible set
- **uat:** the guard empties git's credential helpers, so no run's git hands out the person's
- **blocks:** an app review draws its app's check result as the transcript does (#857)
- **blocks:** show a number field's range before any submit

## 1.54.0 (2026-11-09)

### Features

- **tools:** a --strict cited-commits run fails on a token that isn't an object
- **tools:** check that every commit a note or pr body cites is on github

### Fixes

- **composer:** keep a draft's attachments over a switch, as its text is
- **permissions:** an edit that changes nothing is a plain allow
- **blocks:** an all-strings options error's example id starts with a letter or digit (#951)
- **message-queue:** Send now finds its entry in the pending queue, and refuses one already sent
- **remote:** #1043's smaller points: probe exit, its clock, sign-in PATH, looked text (#1066)
- **security:** dataset titles and the picker's names keep ZWJ, ZWNJ and VS16, with hidesName
- **security:** a host's stored short name is kept unchecked when a change leaves it alone
- **app:** a reply arriving while you read up counts on the pill without reading layout (#1047)
- **security:** one surrogate-safe cut for every clip, and names and titles kept before the checks
- **security:** refuse hidden characters in a short name and dataset title, mark them in the picker

## 1.53.1 (2026-11-09)

### Fixes

- **blocks:** a late answer to an AskUserQuestion tells the agent its question and labels (#521)
- **blocks:** a question whose wait ends mid-turn lets go of the running turn's need (#521)
- **blocks:** an AskUserQuestion's block holds its call's id, and a host keeps the card (#521)
- **blocks:** AskUserQuestion asks as choice blocks, and the answers are its result (#521)

## 1.53.0 (2026-11-09)

### Features

- **adapters:** Always allow on an Antigravity read card makes its folder readable (#338)

### Fixes

- **wake-cards:** the declined-add trigger counts only mentions before the decline was lifted (#789)
- **queue:** break a clock tie by arrival, so same-millisecond messages keep their order (#733)
- **permissions:** judge a read by the file it leads to, not the link's folder (#338)
- **permissions:** offer the folder a read card is about, and read a saved one at once (#338)
- **queue:** a shutdown’s log counts the first waiting delivery too (#733)
- **runtime:** stop settles a turn’s steps from the pending session
- **runtime:** endJob decides on held steps from the pending session
- **catch-up:** an item brought forward in a topic thread moves seenIn to its stub
- **runtime:** bringForward moves catch-up markers held behind a commit
- **wake-cards:** mark a declined add lifted when the person adds that agent
- **queue:** fold the thread’s queue into the next turn whatever other threads wait
- **adapters:** start the read card's offer with its folder, so the card reads whole (#338)
- **adapters:** judge a read card's folder by its true case (#338)

## 1.52.1 (2026-11-09)

### Fixes

- **remote:** mark a turn as waiting for its backend only when nothing else holds it (#965)
- **uat:** keep every run's agents off the person's real GitHub
- **personas:** the Undo-during-purge tests wait for the slow forget, not a fixed time (#1039)
- **sandbox:** let only Postbox’s page frame the app and Mermaid sandbox pages
- **remote:** the Interrupted hint says a turn waits for its backend, not for its host (#965)
- **remote:** a host turn's PATH holds the daemon's own Node folder after the login shell's (#672)
- **remote:** a failed re-probe keeps the first PATH; a host's status carries loginPath (#672)
- **remote:** run host turns with the login shell's PATH (#672, #474)

## 1.52.0 (2026-11-09)

### Features

- **app:** set a room’s wake chain limit from its menu (#1035)
- **wakes:** a room’s own wake chain limit, 1,000 by default (#1035)
- **uat:** items-skipped, the run read a long room with most items skipped, in phase 5 (#712a)
- **transcript:** a jump makes its target the anchor, kept until you scroll (#712a)
- **transcript:** the browser skips the layout and paint of transcript items off screen (#712a)

### Fixes

- **backends:** read a local CLI's version as a host's daemon does
- **blocks:** the reaction row in six elements, each button drawing its icon and count
- **app:** a skipped item's paint keeps 4 px past its box, for a focus ring at its edge
- **app:** at 767 px or narrower the transcript keeps the room held below its newest message
- **files:** an attachment keeps only what Postbox knows of it
- **files:** an upload’s name keeps VS16, so an emoji in it stays whole
- **files:** a message’s file attachment takes its upload’s name, type and size
- **remote:** a host setting that’s now refused stops its link, saying why, instead of exiting
- **remote:** refuse hidden characters in host paths, and replace them in upload names
- **app:** an app's item drawn near the view looks again for the frame under a resting pointer
- **app:** landed() leaves the jump to you once input of yours has come during it
- **app:** the jump to the end is ended once it lands there
- **app:** a move up of 24 px or less is the browser's, whether or not the page got shorter
- **app:** the browser's move up counts only as far as what the page lost, and 24 px more
- **app:** a move up the browser makes as the page gets shorter keeps the view following
- **app:** heard() leaves the browser's clamp to the end alone
- **app:** the view follows the end only when you went down to it
- **app:** a scroll heard() took in releases a jump's pin, as one that moved does
- **app:** an item two draws hold is let go when the last one is
- **app:** the Tab check walks to the next stop, not every focusable on the page
- **app:** a scroll of yours heard before its event still follows the end
- **app:** the transcript's own hold doesn't take the view to the end for you
- **app:** only the main pane skips items off screen
- **app:** a jump to an item ends the smooth jump to the end
- **transcript:** only input that can scroll the page stops the smooth jump to the end
- **transcript:** while following, only the room below the newest message is held (#712a)
- **transcript:** the smooth jump to the end goes the rest of the way unless you did anything (#712a)
- **transcript:** a jump to the newest message goes to the end, and the view follows (#712a)
- **transcript:** a message appended while following is drawn at its real size at once (#712a)
- **transcript:** the view hears each skipped item's first draw, not only its own size (#712a)
- **transcript:** the pill stays smooth over skipped items, then goes the rest of the way (#712a)
- **uat:** rows-skipped, from a probe of the items skipped, sampled before any screenshot (#712a)
- **transcript:** a jumped-to item stays drawn until painted, so a deep target stays drawn (#712a)
- **transcript:** an item with a full-screen review or app, or a check frame, isn't skipped (#712a)
- **uat:** shotItem leaves the jump where it lands, below the top bar, so it stays pinned (#712a)
- **transcript:** the Work list's jump to an item goes through jumpTo (#712a)
- **transcript:** a jump measures its target drawn, and centers it below the top bar (#712a)
- **uat:** the runner's scrolls to an item go through the page's jumpTo (#712a)
- **transcript:** Alt+arrow between items focuses without scrolling, then jumps (#712a)
- **transcript:** Show in sources jumps through jumpTo (#712a)
- **transcript:** the side line's jump to its card goes through jumpTo (#712a)
- **transcript:** ⌃J and a needs ring jump to the ask through jumpTo (#712a)
- **transcript:** Go to it and a retired app's link jump through jumpTo (#712a)

## 1.51.1 (2026-11-09)

### Fixes

- **app:** a press on a folded reply's summary builds its list before it opens
- **app:** build a reply’s folded steps only when its list opens

## 1.51.0 (2026-11-08)

### Features

- **adapters:** Kiro's Auto runs what its persona's Tools allow, with .kiro and .git guarded (#136)

## 1.50.1 (2026-11-08)

### Fixes

- **ledger:** pushes that landed before a command failed, at most 100 (#978)
- **ledger:** a tag pushed isn't the push's branch (#978)
- **ledger:** one push entry for each push a command made (#978)

## 1.50.0 (2026-11-08)

### Features

- **adapters:** Antigravity's Auto runs what its persona's tools allow (#416)

### Fixes

- **app:** Antigravity's copy says what runs with no card, and what decides it (#416, #794)

## 1.49.1 (2026-11-08)

### Fixes

- **remote:** ask the host to stop a turn Postbox gives up on, and resume only once it has (#965)

## 1.49.0 (2026-11-08)

### Features

- **adapters:** Always allow on a Codex card saves Codex's own rule (#324)

### Fixes

- **adapters:** start each Codex offer with its rule, so the card's disclosure reads whole (#324)
- **adapters:** a Codex rule only for a program that reads, none on a host card, real hosts (#324)
- **adapters:** no Codex offer without Web, a host only in Auto, the name checked once (#324)
- **adapters:** pipx and poetry are subcommand tools, and dlx runs the next program (#324)
- **adapters:** a Codex rule runs outside its sandbox, so Always allow offers less and says so (#324)
- **adapters:** no Always allow for a tool that runs a program its options name (#324)
- **adapters:** no Always allow for a tool's option as its second word (#324)
- **adapters:** give a Codex persona in Auto with web.fetch network in its sandbox (#324)

## 1.48.0 (2026-11-08)

### Features

- **uat:** seed the big room’s turns and work, and write its snapshot
- **uat:** gitpush's Auto case is a scenario of its own, gitpush-auto
- **uat:** the gitpush scenario, many commits and pushes in Ask me and in Auto
- **uat:** a throwaway git remote for a run, that nothing real can be reached past

### Fixes

- **uat:** gitpush's push pattern keeps its two kinds of option apart
- **cards:** tell the agent a request the person's stop withdrew wasn't refused (#853)
- **server:** read a refused folder of an agent on a host as none, here
- **server:** keep the folder of an agent on a host as written, so its sheet saves
- **server:** say where an attached Claude Code session ran when its folder is refused
- **deps:** skip onnxruntime-node's CUDA download in the repository's .npmrc
- **server:** let a fixed sheet’s folder reach a session that snapshotted a bad one
- **security:** say in the hooks panel that a running hook's allow skips ask rules
- **security:** keep the person's hooks in auto, and turn them off only in ask me and accept edits
- **remote:** a host card that waits on nothing ends when Postbox stops following its turn (#800)
- **security:** a turn that loaded hooks doesn't switch live into a mode that turns them off
- **server:** check agents.json whole before seeding any of its agents
- **server:** refuse a stored bad folder with a 409 everywhere it’s read
- **server:** check a persona’s folder as a project’s folder is checked
- **uat:** a git-remote run reads its own git config, and its preflight runs on runEnv
- **uat:** gitpush's push pattern takes git's own options, and Always allow's own push doesn't count
- **uat:** GIT_ALLOW_PROTOCOL=file, a preflight before Postbox starts, and the agent's env file
- **apps:** a review's new body no longer sweeps apps that aren't on the page yet (#930)
- **uat:** setUpRemote fails closed, and a git-remote run blanks SSH_AUTH_SOCK
- **apps:** an app review's old bodies leave the near set, so the page stops looking (#930)
- **apps:** look under the pointer only near an app, and let go of a view’s apps when it goes (#930)
- **uat:** a session with a card open isn't working, whatever its state says
- **uat:** gitpush changes one line of notes.md in Accept edits
- **uat:** gitpush asks for each commit as its own calls too, and gives the twenty pushes 16 steps
- **uat:** gitpush asks for each push as its own call, and the runner sets the project's repository

## 1.47.0 (2026-11-08)

### Features

- **tools:** signoff-checks fails a head that lacks CodeQL or any required check

### Fixes

- **tools:** signoff-checks errors on empty rules and lets a queued rerun replace a failure
- **agents:** a mouse press holds the quick panel's repaint without pointer events
- **tools:** signoff-checks reads CodeQL as pending while any check run still runs
- **agents:** a press in the quick panel holds its repaint until it ends

## 1.46.0 (2026-11-08)

### Features

- **apps:** hold back a label cut off by its SVG or a box that doesn't scroll
- **apps:** check the contrast of SVG labels against the shape under them
- **apps:** hold back text under 12 px at 1000 x 680, naming the smallest labels
- **apps:** hold back a figure of boxes holding their names, or a box holding a sentence
- **apps:** hold back a version whose title or figure is below the first view
- **apps:** name each element the app check reports, by a selector and its text

### Fixes

- **apps:** judge a label only where it shows, and see shapes that ignore the pointer
- **apps:** boxes in a few sizes are a diagram's, not a chart's bars
- **apps:** a contrast or text-size measure that throws reports check-error
- **apps:** an accent strip down a box's edge doesn't make it a frame
- **apps:** a chart's marks, a label's backing and a legend's frame aren't text in boxes
- **apps:** judge an SVG label by what's behind most of it, not a hairline through it
- **kit:** set kbd at 12 px in apps
- **apps:** leave an SVG label unjudged when the check can't measure what's behind it
- **kit:** set the kit's labels, table heads and chart text in apps at 12 px

## 1.45.0 (2026-11-08)

### Features

- **uat:** the arena shows a person no repeats, and every intent keeps to 16 words
- **apps:** an app’s intent is at most 16 words, and a longer one is flagged
- **uat:** the side-by-side judge compares two pictures, not a picture and words
- **uat:** a blind page calibrates the side-by-side judge against the maintainer
- **uat:** a judge compares a run’s first picture with a words-only answer
- **uat:** the visual judge compares each app’s takeaway with the agent’s intent
- **apps:** show_app and update_app take the picture’s one-sentence intent

### Fixes

- **uat:** a run with no first picture isn’t saved as one for good
- **apps:** every way of showing an app flags a long intent once, with its true length
- **uat:** no repeats in the arena hold across pages, not only within one
- **uat:** one failed judge call can’t lose the calibration key
- **uat:** a calibration page’s saved picks belong to that page
- **apps:** show_block takes an app block’s intent as show_app does
- **uat:** the calibration page has a content security policy
- **guide:** corpus.search’s result names author and year again
- **uat:** each picture judge reads only what it’s shown, from a folder of its own
- **uat:** a picture judge that throws can’t stop a run before its report
- **uat:** the picture judges run after the verifier, so they can’t spend its reserve
- **uat:** the side-by-side judge sees the finished app, not its check at work
- **uat:** a recheck keeps a run’s picture choice and its pair of answers
- **uat:** the words answer starts from the run’s first files, not the agent’s

## 1.44.4 (2026-11-08)

### Fixes

- **remote:** give a shim's calls random ids
- **remote:** refuse a shim's hello that carries no key
- **remote:** let only the shim that asked a prompt end it
- **remote:** send a tool call's result only to the shim that made it

## 1.44.3 (2026-11-08)

### Fixes

- **permissions:** a file rule escapes the characters Claude Code reads as a pattern
- **permissions:** Always allow on a file saves a rule that names it from the root
- **app:** a review's Preview hears selections through one page listener, held weakly (#945)
- **app:** a project's Threads page lets the room you left go (#945)
- **app:** a review's marked text is let go of a frame after you go to another conversation (#945)
- **app:** the Hosts panel stops listening and ticking once it's off the page, seen or not (#945)
- **integration:** onMachines reports the test's own failure, and teardown ends what it started first

## 1.44.2 (2026-11-08)

### Fixes

- **sessions:** viewing a conversation clears the unread its agents counted behind a held commit
- **sessions:** a turn stopped behind a held commit ends idle once it exits, not stopping
- **catch-up:** a message a summary gives in full reaches the agent once, the person's too
- **sessions:** a session write and a new agent's turn start from the session as held writes leave it
- **threads:** every thread write starts from the thread as held writes leave it

## 1.44.1 (2026-11-08)

### Fixes

- **app:** the places menu reads the projects when it opens (#986)
- **projects:** refuse the shared invisible characters in a folder; check an asset name's first
- **app:** rebuild the top bar only when what it shows changes (#986)
- **assets:** refuse C1, bidi and other hidden characters in a new asset's name
- **files:** send Cross-Origin-Resource-Policy: same-origin on three stored-byte routes
- **projects:** refuse an empty or relative folder when creating a project
- **telemetry:** check a session.patch's own public flag before keeping it

## 1.44.0 (2026-11-08)

### Features

- **permissions:** Always allow on a host card, kept by Postbox and sent in the host turn's settings
- **permissions:** harness first: in Auto, Postbox adds no ask rules of its own for writes

### Fixes

- **remote:** one field for a host turn that may still run, and its hint says it waits
- **remote:** only a host turn listed running waits for the person
- **remote:** a listed host turn whose backend wasn't registered waits for the person
- **remote:** interrupt a host turn whose backend isn't registered after a restart
- **permissions:** a host's kept Always allow settles a write, and the card names the asking host
- **permissions:** the panel keeps "Writes you asked for" in Auto, where it still applies

## 1.43.0 (2026-11-08)

### Features

- **uat:** record whether the agent chose a picture or words

### Fixes

- **uat:** read the picture measure's log through lines()
- **uat:** a run whose agent never replied is unknown, not words

## 1.42.0 (2026-11-08)

### Features

- **uat:** trigger host-queued-refused, and remotehosts phase 7 (#827)

### Fixes

- **remote:** answer a queued call once its record is written, whatever Postbox did (#827)
- **remote:** a queued call on a host waits for the daemon, so a refusal reaches its agent (#827)
- **uat:** resolve a session's working folder before naming its Claude Code transcript (#932)

## 1.41.2 (2026-11-08)

### Fixes

- **apps:** a retired app's item keeps to the message column

## 1.41.1 (2026-11-08)

### Fixes

- **apps:** don't report the ResizeObserver loop warning as an app error

## 1.41.0 (2026-11-08)

### Features

- **apps:** the app check reports a choice shown by toggling .ghost
- **apps:** add a primary button variant for agent apps
- **uat:** fault stop-runner, trigger host-hung-killed, and remotehosts phase 6 (#872)

### Fixes

- **agents:** the guide says which control is for a choice and which for an action
- **uat:** phase 6 hangs the runner while a long reply is written (#872)
- **uat:** stop-runner also matches a runner under the resolved home folder (#872)
- **remote:** say a host turn ended unkilled in the daemon's welcome too (#872)
- **remote:** crossing looks at a silent host runner keep the newer one's verdict (#872)
- **remote:** keep a host runner's silence in its turn folder across daemon restarts (#872)
- **remote:** a silent host runner's process check stands for 5 s, but not at the ceiling (#872)
- **remote:** kill a host runner hung past the silence ceiling before its turn ends (#872)

## 1.40.1 (2026-11-08)

### Fixes

- **apps:** send a script error in the pre-display check back to the agent once
- **apps:** keep an app that has drawn running after a script error
- **tests:** a browser spec's Postbox removes its folder when its start or its close fails
- **tests:** the host UAT and view_app stop tests use tempDir
- **tests:** the push, runner shot and unhandled rejection process tests use tempDir
- **tests:** the bench signal and lint process tests use tempDir
- **tests:** the host integration tests and the host UAT tests use tempDir
- **tests:** the remote e2e tests and the host manager fixture use tempDir
- **tests:** the remote attachment and cleanup tests make their folders with tempDir
- **tests:** the app browser, persona delete and steering tests use tempDir
- **tests:** the asset tools fixture and wiring tests use tempDir
- **tests:** the archive, prompt claim and asset privacy tests use tempDir
- **tests:** the review route, prototype key and runtime route tests use tempDir
- **tests:** the epoch, server token and served files tests use tempDir
- **tests:** the wake-owner, persona outage and store gate tests use tempDir
- **tests:** the store outage tests make their data folders with tempDir
- **tests:** tempDir removes its folders when the test file's process exits

## 1.40.0 (2026-11-08)

### Features

- **skills:** the visual-explainer draws one step's cause close up (VE9)
- **skills:** the visual-explainer's first state shows the idea (VE13)
- **app:** search the conversation from the top bar's button, and jump to a hit (#866)

### Fixes

- **app:** the top bar clips its overflow, so it never widens a phone's page (#866)
- **skills:** the visual-explainer sizes from a frame that can start 0 wide
- **thread:** a box that changed size and clamped the view to its end doesn't start following
- **app:** holders of drawn elements hold them weakly, so leaving a room lets its page go (#866)
- **check:** fail the gate on what test and test:integration leave in its temp folder
- **agents:** the quick panel repaints for its session, persona and a reload, not each item

## 1.39.3 (2026-11-07)

### Fixes

- **catalog:** the string-options error's example is a valid option itself (#455)
- **remote:** a host asks hostUpdateRefusal before sending an update_block, in one place (#854)
- **remote:** a host's shim refuses an invalid update_block in the call, as Postbox would (#854)
- **catalog:** string options get one error with an option's shape, and the docs name it (#455)
- **catalog:** options with no id aren't reported as duplicates of "undefined" (#552)
- **remote:** a host's daemon queues an outcome or withdraw update_block for Postbox (#854)

## 1.39.2 (2026-11-07)

### Fixes

- **app:** go to a new conversation once the page has it (#926)

## 1.39.1 (2026-11-07)

### Fixes

- **needs:** rank an offered card against the need as nextNeed does

## 1.39.0 (2026-11-07)

### Features

- **adapters:** Antigravity, Kiro and Codex leave out the skills a persona turned off
- **personas:** choose which skills each agent loads
- **adapters:** Antigravity, Kiro and Codex agents load the visual-explainer skill too
- **adapters:** every Claude agent loads Postbox's visual-explainer skill by default

## 1.38.0 (2026-11-07)

### Features

- **server:** view_app shows an agent its app as the person first sees it

### Fixes

- **app:** the view report reads the conversation's width without a document query
- **server:** view_app starts up in one call, keeping start() under its ceiling
- **app:** view_app shows a check's note as the person sees it
- **server:** view_app's pictures stay out of the project's commits
- **server:** view_app's browser can't hang a call or outlive a stop
- **server:** view_app asks again a week after Not now
- **app:** view_app's picture is as wide as the app the person sees

## 1.37.1 (2026-11-07)

### Fixes

- **remote:** a host answers a permission prompt only on the connection that sent it
- **permissions:** a host’s permission prompt counts only for a call its stream showed
- **permissions:** a permission prompt counts only for a call the stream showed, once

## 1.37.0 (2026-11-07)

### Features

- **hosts:** show each host as a short badge in the agents list
- **app:** show agent names without the @

### Fixes

- **uat:** staging matches the runs folder by its real path too
- **tests:** check's first signal goes to the stage's whole process group
- **runtime:** don’t let a subagent’s step split an agent’s words
- **runtime:** start a reply’s words anew after a tool call when others spoke
- **hosts:** refuse invisible characters in a host’s short name
- **hosts:** name a removed host’s badge, and drop an IPv6 zone
- **runtime:** keep a reply’s words in one part while others write
- **runtime:** place a reply’s words where the agent wrote them
- **threads:** put reactions left of the thread button
- **tests:** the remote pipeline's machine folder goes through tempdir
- **tests:** a second ctrl-c or a sighup ends the gate and removes its run folder
- **tests:** the gate's temp sweep never makes a hard-linked file outside writable
- **uat:** a postbox that fails to start is stopped before the error reaches its caller
- **uat:** the run's postbox sleeps with node's timers, not through the browser module
- **uat:** staging forgets only its own gone worktrees, never prunes the checkout

## 1.36.4 (2026-11-07)

### Fixes

- **app:** Reply in thread’s own focus timer leaves focus the person moved (#887)
- **app:** open a topic thread’s panel when its event lands after its address

## 1.36.3 (2026-11-07)

### Fixes

- **app:** the view notes a shrink at once for a removal-only batch and a whole redraw (#903)
- **app:** the view's change watcher reads the page at most once a frame
- **lint:** lint-ternary and lint-caps compare with upstream/main when it is newer
- **hooks:** the hook names lint-ternary, and npm run hooks says what it changes
- **lint:** lint-ternary lets a pure move of an old nested ternary through
- **lint:** lint-ternary honors a line-level lint-allow ternary with a reason

## 1.36.2 (2026-11-07)

### Fixes

- **remote:** only a result holds off the stall stop, and each task keeps its own 2 h (#847)
- **remote:** a listed background task holds off the stall stop for up to 2 h (#847)
- **permissions:** name PermissionRequest hooks in the panel, with each hook's event
- **permissions:** hide credentials in hook matchers, as in their commands

## 1.36.1 (2026-11-07)

### Fixes

- **server:** refuse a topic-thread send to an unavailable agent before it joins
- **server:** refuse requests about an unregistered backend with a 422
- **server:** fail a turn for an unregistered backend with a reason and Retry

## 1.36.0 (2026-11-07)

### Features

- **state:** apply turn.archive, a public event nothing emits yet
- **uat:** the failed-reply-dismissed trigger (#883)
- **threads:** Dismiss a failed reply without running it again (#883)

### Fixes

- **threads:** after Dismiss, focus stays on the control that's left (#883)

## 1.35.6 (2026-11-07)

### Fixes

- **assets:** a rename of a deleted asset is refused, and says to restore it first
- **state:** the asset handlers check their payload before changing anything
- **assets:** a rename or delete retried without an op is a repeat, and another agent's is stale

## 1.35.5 (2026-11-07)

### Fixes

- **thread:** a redraw of the conversation keeps focus and the caret where you were typing
- **blocks:** an update that changes nothing the person sees leaves a waiting block as it was

## 1.35.4 (2026-11-07)

### Fixes

- **tests:** flag a bare account key before "=" only where toml puts a key
- **tests:** clear the recording person's plugins and own skills from two claude code inits
- **tests:** the commit scan checks the name of every path a commit adds, copies or renames
- **tests:** the commit scan masks a private file name in every finding in that file
- **tests:** the privacy checks print a finding's kind, file and line, never what they found
- **tests:** the tree test and the commit scan check the names of the files they read
- **tests:** the privacy check flags bearer tokens, uid fields and bare or toml account fields
- **tests:** clear recorded inits' connectors and plugins, and flag a connector a person named
- **tests:** clear the recorded codex resume turn's account metadata and drop its privacy exemption

## 1.35.3 (2026-11-07)

### Fixes

- **blocks:** a chosen option's description reads on its chip in the light theme (#873)

## 1.35.2 (2026-11-07)

### Fixes

- **adapters:** count open_topic among Postbox’s quiet tools
- **uat:** find a message’s thread link by its class, not by the word “thread”
- **server:** open_topic says whether it posted its message, and by which id
- **server:** cap open_topic’s mentions and check each handle’s shape first
- **server:** import SUMMARY_MODEL from its own module, out of the catch-up cycle
- **remote:** the follower ends a turn through followerEnds, and the design says so (#738)
- **remote:** log a silent host runner as not answering as its runner (#738)
- **remote:** time a silent host runner on a monotonic clock
- **remote:** keep a silent host runner running while its process lives

## 1.35.1 (2026-11-07)

### Fixes

- **skills:** the visual explainer also loads on questions about how code is put together
- **skills:** the visual explainer loads on everyday asks about code and data

## 1.35.0 (2026-11-06)

### Features

- **uat:** a scenario can put the person’s own files in the workspace

### Fixes

- **app:** choices are fitted in one pass, so a room's choices cost one layout, not one each
- **app:** timeOf and dayOf format with one Intl.DateTimeFormat each, made once

## 1.34.1 (2026-11-06)

### Fixes

- **skills:** a chart whose marks carry the values counts as drawn
- **agents:** a predict-first question sits beside the picture, never in front of it

## 1.34.0 (2026-11-06)

### Features

- **uat:** the customer judges the visual, with `- judge: visual`

### Fixes

- **agents:** a picture that explains draws the things, not labeled boxes
- **uat:** the customer's relationship check applies where the idea is a dependence
- **skills:** VE11 applies only where the idea is a relationship between variables

## 1.33.0 (2026-11-06)

### Features

- **security:** the permissions panel names the PreToolUse hooks Postbox turns off (#817)

### Fixes

- **security:** the hook list hides values named like credentials, and bearer tokens (#817)
- **security:** an Agent SDK turn started in bypass keeps it until it ends or is stopped (#817)
- **security:** the hook list marks every format character, filler, tag and variation selector (#817)
- **security:** the hooks panel doesn’t say there are none when no file could be read (#817)
- **security:** the hooks panel says a host agent’s list is this computer’s settings (#817)
- **security:** the hook list marks bidi and zero-width characters like control characters (#817)
- **security:** Postbox’s own settings turn off hooks and mods in every mode but bypass (#817)

## 1.32.1 (2026-11-06)

### Fixes

- **agents:** the researcher's picture is for visual explanations, with predict-first kept
- **mock:** the demo explainer shows a picture with a control, and practice only on request
- **skills:** list all twelve content shapes in the visual-explainer run
- **agents:** an explainer is a picture with a control, and practice only on request

## 1.32.0 (2026-11-06)

### Features

- **uat:** window-paged-back, reading at the big room's first day (#531)
- **uat:** the view probe, each transcript's view each step before any screenshot (#531)
- **checks:** view-moved, the view moving or changing mode with no input between (#531)

### Fixes

- **uat:** the runner's last check pass decides the run's unverified rows
- **checks:** view-moved tallies each transcript's pairs, and says when it compared none
- **checks:** view-moved reads the runner's moves as inputs, and says when the probe saw nothing
- **checks:** view-moved spans unsettled samples, keys each finding, says when it checked nothing
- **uat:** the view probe escapes the last anchor it splices into page code
- **checks:** view-moved reads each transcript's previous sample from a map

## 1.31.0 (2026-11-06)

### Features

- **review:** Lines draws a review's attached figures as Preview does (#780)
- **uat:** triggers and a scenario for a review that shows two figures, here and on a host (#780)
- **review:** show_block's description says a review can carry images from the agent's folder (#780)
- **remote:** a review block shown from a remote host carries its images (#780)
- **review:** Preview shows a review's attached images from the item's route (#780)
- **server:** the item's route serves a review's image, same-origin only (#780)
- **review:** show_block and update_block keep a review's images with each revision (#780)
- **review:** read an attached image's type and size from its header bytes (#780)
- **review:** an image target resolves to a file attached to the block, by exact key (#780)

### Fixes

- **remote:** a host app's data file record keeps only its name, SHA-256 and size (#780)
- **review:** release a call's staged blobs when a later put fails, and 404 a gone blob (#780)
- **review:** a call's review images are kept only when an item took them (#828)
- **test:** #780's swap and blob specs remove their temp folders, as main now checks (#780)
- **remote:** a host's review call with files waits for Postbox's answer (#780)
- **review:** a refused review call never removes bytes an ordinary put has in flight (#780)
- **review:** refuse files on a review's withdraw or outcome (#780)
- **review:** keep at most 8 replaced files on a review item (#780)
- **review:** keep a review's images only when its block is shown or updated (#780)
- **review:** check every file before storing any, and keep the header's filename whole (#780)
- **server:** agentFile reads the file it opened and checked, not a link swapped in after (#780)

## 1.30.0 (2026-11-06)

### Features

- **tools:** a server bench measures the snapshot stall, /api/state, streaming and startup by size
- **tools:** the snapshot-stall bench writes through the server's writeSnapshot and seeds --items

### Fixes

- **tools:** the server bench checks its streamed reply landed, and the stall bench its seeded room
- **tools:** the server bench checks each startup replayed its log, and reports the measured count
- **tools:** the server bench writes its report whole, and a stop waits for the write
- **tools:** the snapshot stall bench refuses --items with --snapshot or --data
- **tools:** the snapshot stall bench refuses a missing or unparsable --snapshot or --data
- **tools:** the server report no longer says the reducer finds a streamed item by a scan
- **tools:** the server bench stops on SIGINT or SIGTERM after the size in progress cleans up

## 1.29.0 (2026-11-06)

### Features

- **uat:** the runner turns host1's consent on for the phase that removes Postbox there (#464)
- **uat:** fault remove-postbox, trigger host-reinstalled, and remotehosts phase 5 (#464)
- **app:** the host's card says when Postbox was installed there again with a new token (#464)
- **remote:** an install that made a new token says tokenChanged, recorded reinstalled (#464)

### Fixes

- **uat:** a fault's verb sits beside its noun, and fault() takes the host's runner (#464)
- **app:** the card says reinstalled for a day after it, not on every connect after (#464)
- **uat:** remove-postbox refuses a pre-existing install, and says why it failed (#464)
- **app:** the card says reinstalled only while the host is connected (#464)
- **remote:** Install… repairs an unreadable token here, and reinstalled needs a new install (#464)

## 1.28.1 (2026-11-06)

### Fixes

- **permissions:** Postbox matches a trailing wildcard as Claude Code does
- **permissions:** a bare push behind git's options gets its own ask rule
- **permissions:** a push behind git's own options comes to Postbox too
- **permissions:** a "no" turns a request around only for the words after it

## 1.28.0 (2026-11-06)

### Features

- **blocks:** an option may carry a description, under its label

### Fixes

- **guide:** show a form option's shape, and that an option takes only id and label
- **blocks:** a table's year or id column shows its numbers as written
- **tools:** the UAT screenshot tool gives scenes the demo's UI, and skips missing views
- **uat:** a run whose telemetry fails still writes its report and findings

## 1.27.0 (2026-11-06)

### Features

- **uat:** session-scoped, #564-b1's trigger, from a probe of whole-page lookups per session event

### Fixes

- **rail:** find the shell's root from the rail's toggle, not by a lookup over the page (#564-b1)
- **transcript:** a replaced latest reply hands its line on; lines off the page wait (#564-b1)
- **open-asks:** any item change or a removal clears the kept blocks; off-page buttons wait (#564-b1)
- **transcript:** a session event paints the lines that follow it, kept as they're drawn (#564-b1)
- **open-asks:** repaint the session’s own buttons, from blocks kept per session (#564-b1)
- **rail:** a session event looks for its rings in the rail and strip, not the whole page (#564-b1)

## 1.26.0 (2026-11-06)

### Features

- **uat:** trigger host-turn-waited-install, and phase 4's first turn waits (#464)
- **app:** show a host’s automatic install on its card and a turn’s line, with its toggle (#464)
- **remote:** put a failed automatic install's reason on the host's status for its card (#464)
- **remote:** a caller that hears a 127 waits for the install it started (#464)

### Fixes

- **remote:** Install… supersedes a failed try as present, so the card says nothing (#464)
- **remote:** Install… supersedes a failed automatic try; other versions' tries say nothing (#464)
- **remote:** a waiter on a withdrawn install throws the host's own failure, with Install… (#464)
- **remote:** Stop ends a turn's wait for the automatic install at once (#464)
- **uat:** host-turn-waited-install dates a waited turn by the message that asked for it (#464)
- **remote:** a caller waiting on a busy install goes on when the host connects (#464)

## 1.25.0 (2026-11-06)

### Features

- **tools:** the key-to-frame report records the conditions behind its numbers
- **uat:** key-frame-measured, a smoke check that a run measured its room
- **tools:** measure key-to-frame p95 by room size for PF-1

### Fixes

- **tools:** a calibration key proves Event Timing measures this composer
- **tools:** each run opens the room in a new document, and a key the page doesn't type is refused
- **tools:** judge a 1x room under one frame at 16 ms, and leave the verdict to the report
- **tools:** a key-to-frame room with a null count of missing keys is not measured
- **tools:** a key-to-frame room with too many keys missing an entry is not measured
- **tools:** the key-to-frame report says why it shows the next-frame timer
- **tools:** the key-to-frame run reads the window’s size from Chromium, and checks every edge
- **uat:** the big-room scenario measures its room, and its first phase waits for key-frame-measured
- **uat:** key-frame-measured can’t tell on a run that didn’t have --measure-key-frame on
- **uat:** a run’s key-to-frame measurement empties the composer even when it fails
- **tools:** the key-to-frame bench takes only positive whole numbers for its counts
- **tools:** Ctrl-C or SIGTERM stops the key-to-frame bench without leaving a size’s data folder
- **tools:** the key-to-frame bench removes a size’s data folder when its Postbox doesn’t start
- **tools:** the key-to-frame report shows paths relative to the repo, never absolute
- **tools:** the key-to-frame run refuses a composer outside the window
- **tools:** page.size() sizes the window too, so a key typed below 600 px is presented
- **tools:** the key-to-frame report says "1 run a size", and the p95 rounds up
- **uat:** big-room ids sort past 10,000 items, and its seed takes a count

## 1.24.1 (2026-11-06)

### Fixes

- **permissions:** a store outage stops a host turn as the store, not as the person (#721)
- **permissions:** only the person's Stop holds back an expiry note, here and on a host (#721)
- **permissions:** an expired card stops needing you, and its agent is told to ask again (#721)

## 1.24.0 (2026-11-05)

### Features

- **uat:** a runner shot keeps the view, inputs are recorded, and the tester scrolls (#531, B1b-b)

### Fixes

- **uat:** keepView puts the view back without hiding the capture's own error (#531, B1b-b)
- **uat:** keepView checks the view one frame after it puts it back, not two (#531, B1b-b)
- **uat:** telemetry clicks and reloads are recorded as inputs that move the view (#531, B1b-b)
- **uat:** a runner click scrolls only when it can't reach its control where it is (#531, B1b-b)
- **uat:** a read inside an app puts the view back, and an app click records once (#531, B1b-b)

## 1.23.1 (2026-11-05)

### Fixes

- **tests:** make the unit fixtures' host homes where their sockets fit
- **tests:** a folder a test makes read-only is made writable again in t.after
- **tests:** the last temp folders removed at a test's end are removed in t.after or by tempDir
- **tests:** the store-retry family's folders are removed even when a test fails
- **tests:** the lifecycle, shim, Ctrl-C and leftovers fixtures make their folders where sockets fit
- **tests:** tempDir removes a folder with a read-only folder inside it
- **tools:** the gate’s sweep skips a system without user ids and a temp folder it can’t list
- **tools:** a gate run folder that can’t be removed is a warning, not a failed check
- **tools:** pass Ctrl-C and SIGTERM to the gate's running stage, then remove its run folder
- **tests:** make the socket fixtures’ temp folders under TMPDIR where their socket paths fit
- **tools:** run the gate’s tests in a temp folder of the run’s own, and sweep killed runs’
- **tools:** let POSTBOX_HEAVY_DIR name the heavy-lock’s slot folder
- **tests:** the integration host and install fixtures remove the folders they make
- **tests:** read-only test folders are made writable again whatever fails
- **tests:** the store tests remove their folders even when an assertion fails
- **tests:** the store, corpus, seed and runtime tests remove their temp folders
- **tests:** the Antigravity tests remove their temp folders
- **tests:** the Kiro tests remove their temp folders
- **tests:** the permission and request tests remove their temp folders
- **tests:** the telemetry fixture removes its folders after each test file

## 1.23.0 (2026-11-05)

### Features

- **app:** the Remove confirm says it waits for an install under way, and how long (#464)
- **uat:** add the host-auto-installed trigger and the auto-install-repeated check (#464)
- **uat:** turn a staged host’s consent on through the page, and keep install tries (#464)
- **remote:** install this Postbox’s version on a host by itself, with the person’s consent (#464)

### Fixes

- **remote:** Install… refuses a host being removed, and runs its own after a withdrawn one (#464)
- **remote:** Remove waiting on an install removes nothing once Postbox has closed (#464)
- **remote:** an install a crash or close() cut off says so on the host's status (#464)
- **remote:** no install after the consent is turned off, and Remove waits for one under way (#464)
- **types:** keep nextNeed's best typed after its refusal count, for TypeScript 7 (#464)
- **remote:** refuse a linked records folder, and critic’s three smaller points (#464)
- **remote:** read the install record through one open that can’t follow a link or wait (#464)
- **remote:** refuse an install record far larger than Postbox writes, unread (#464)
- **remote:** Remove doesn’t install on the host it’s removing (#464)
- **remote:** turning the consent on reconnects a stopped host once, and no nested ternary (#464)

## 1.22.0 (2026-11-05)

### Features

- **transcript:** the view publishes what it is on the transcript, as data-view-* (#531, B1b-a)

### Fixes

- **transcript:** heard() keeps its box-size check again, so a resize leaves what you read (#88)
- **transcript:** a view that unsticks on an unheard scroll takes that scroll in once (#341)
- **transcript:** a redraw takes a vanished anchor again; the panel publishes too (#531, B1b-a)
- **transcript:** a scroll the transcript hasn't heard of yet isn't taken back by a resize (#341)

## 1.21.1 (2026-11-05)

### Fixes

- **catch-up:** heldFor reads the open card from published items (#693)
- **wakes:** a closed card's held message is due from its close, and its asker gets one note (#693)
- **wakes:** close cards after the restore, tell everyone, keep the person's latest decline (#693)
- **catch-up:** name a message held for an agent on a card that waits for the person (#693)
- **wakes:** a card whose agent is archived, removed or retired closes, and held agents hear (#693)
- **wakes:** after the person declines adding an agent, a prose mention asks no more (#693)

## 1.21.0 (2026-11-05)

### Features

- **uat:** add the erased-conversation-commands trigger to assets-delete

### Fixes

- **uat:** leave out a Bash call Claude Code never ran from work-commands-match-stream
- **uat:** split the turns' streams when only never-run sessions are left
- **uat:** refusal-without-card counts cards and refusals by agent once
- **uat:** pin how erased-session checks read the Undo window, removals and topics
- **uat:** keep every stream when no session in the state has an id
- **uat:** refusal-without-card compares each agent's refusals with its cards
- **uat:** the host half of work-files-match-stream skips erased sessions
- **uat:** checks that compare streams with the state skip erased sessions

## 1.20.5 (2026-11-05)

### Fixes

- **antigravity:** a filesystem that refuses chmod still starts the turn
- **antigravity:** hooks.json is read-only on every umask

## 1.20.4 (2026-11-05)

### Fixes

- **state:** read items by id through the index on the server and in the page
- **state:** find an item by id through one index kept outside the state

## 1.20.3 (2026-11-05)

### Fixes

- **tools:** the diff parser fails a hunk with no file, and both tools ask git for one diff shape
- **tools:** the commit scan runs through a folder reached by a symlink
- **tests:** the commit scan checks the privacy checker's own files like any other
- **tests:** the commit scan refuses git older than 2.36, naming both versions
- **tests:** scan merges, commit messages and -diff files, whatever git config says

## 1.20.2 (2026-11-05)

### Fixes

- **uat:** a recheck reads the phases a run played, and keeps them in run.json

## 1.20.1 (2026-11-05)

### Fixes

- **store:** newId always returns 8 letters or digits

## 1.20.0 (2026-11-04)

### Features

- **uat:** stage an older Postbox on a test host (#464)

### Fixes

- **uat:** record a staged host cleared at the end of the run as gone (#464)
- **uat:** test the refused-host guard, read a plain run’s phases in the recheck (#464)
- **uat:** keep --phase working on remotehosts, record the phases played, refuse a newer tag (#464)
- **uat:** refuse staging with --replace-host-install, and narrow its cleanup (#464)
- **uat:** give the staged installer the host’s full settings (#464)
- **uat:** skip the staged phase in a plain run, and clear a staged host (#464)

## 1.19.1 (2026-11-04)

### Fixes

- **tests:** the privacy check joins each stream's deltas, and scrubs denials.jsonl's split slug
- **tests:** the privacy check's case-blind home folders load on Node 22
- **tests:** the privacy check reads its own files, any case, in linear time
- **tests:** git ignores check-logs/, and the committed check log is untracked
- **tests:** close the privacy check's gaps the review found
- **tests:** scrub account usage and home paths from committed files

## 1.19.0 (2026-11-04)

### Features

- **tools:** fail a nested ternary on a line the change adds

### Fixes

- **tools:** lint-ternary fails a file with more nested ternaries than at the base
- **tools:** the lints run from a folder reached through a symlink
- **tools:** lint-ternary counts each hunk's lines, and fails cleanly outside a checkout
- **tools:** the lints run from a folder whose path has a space

## 1.18.2 (2026-11-04)

### Fixes

- **delivery:** name a newer waiting message from the turn’s sender on the next tool result

## 1.18.1 (2026-11-04)

### Fixes

- **uat:** an app click hits the button inside a matching row, and phase 3 needs one click (#366)
- **needs:** a failed reply is a card tied to its turn, so a wake keeps its Retry (#366)
- **needs:** a wake's end keeps a failed turn's Retry, and ties compare the cards' times (#366)
- **needs:** a Store Retry settles a cut-off turn's need as a restart does (#366)
- **needs:** a turn that doesn't move on keeps the turns still asking you (#366)
- **needs:** a restart keeps the need it had while its card still waits (#366)
- **needs:** the kept block is on the session, so a restart keeps it (#366)
- **needs:** a turn is the last turn from its start, and a restart sets the need it left (#366)
- **needs:** Retry falls back only to cards that wait until answered (#366)
- **needs:** a failed turn ranks ahead of every card, and is recorded as the last turn (#366)
- **needs:** a turn that doesn't move on keeps its block through a mid-turn release (#366)
- **needs:** which turn's cards count is read from the store, and every setter keeps the order (#366)
- **needs:** the turn's end notifies an app card it makes the need, and three more specs (#366)
- **needs:** the next need keeps main's order and counts several refusals (#366)
- **needs:** an agent needs you until its last waiting card is answered (#366)

## 1.18.0 (2026-11-04)

### Features

- **uat:** TRIGGERS knows #701's diagram-deferred
- **uat:** diagram-deferred, #701's trigger, from a diagram probe taken before screenshots
- **uat:** `- seed-diagrams: n` ends n of the big room's agent replies in a Mermaid diagram (#701)

### Fixes

- **uat:** #701 packet findings: seed wiring tested end to end, exact page loads, probe branches
- **uat:** diagram-deferred counts diagram pages asked for; eager frames out of view never draw
- **thread:** a diagram frame loads only as it nears the view

## 1.17.0 (2026-11-03)

### Features

- **uat:** a conversation delete can wait for a time, so it lands where a phase needs it
- **uat:** the tester deletes, restores, starts and opens conversations, and restarts locally

### Fixes

- **uat:** a delete at a time waits until the clock has reached it
- **uat:** Undo's time is taken before its click, so a turn right after Undo isn't in the window
- **uat:** the content check skips only what someone wrote, and looks things up in sets

## 1.16.1 (2026-11-03)

### Fixes

- **assets:** a write to a deleted conversation says it was deleted
- **threads:** no turn starts in a conversation's Undo window, and the purge stops any it has

## 1.16.0 (2026-11-03)

### Features

- **assets:** six tools for a conversation's assets, local and on a host

### Fixes

- **remote:** a host's refused call says Postbox may be reconnecting, not only closed
- **assets:** one set of read tools, so a host's repeat of an asset read is read again, whole
- **assets:** list_assets reads one room from its index; versions by their index

## 1.15.0 (2026-11-03)

### Features

- **assets:** the readers the asset tools share with the write path
- **assets:** released files are deleted at load, and an erased conversation takes its assets
- **assets:** one commit path for a conversation's asset versions
- **state:** a conversation's assets and the hashes their prunes release

### Fixes

- **assets:** say a conversation is being deleted, not that it's missing
- **assets:** refuse a write to a conversation that's gone or being deleted
- **assets:** a room index the reducer keeps, so a write's checks look up

## 1.14.1 (2026-11-03)

### Fixes

- **composer:** an empty composer stays one line when its placeholder wraps
- **composer:** a key typed into the composer costs one layout, not three

## 1.14.0 (2026-11-03)

### Features

- **threads:** an agent opens a topic thread from any message with open_topic (#637)

### Fixes

- **threads:** the no-handle refusal quotes its example as the list refusal does (#637)
- **threads:** agentWake refuses a wake from a summary's turn, for every tool (#637)
- **threads:** open_topic posts its message first and wakes each mention from it (#637)
- **threads:** open_topic posts its message when no wake did, and the reply says why (#637)
- **threads:** a host's queued call the gate refuses gets no reply, so it runs again (#637)
- **threads:** I6 compares the handles an open named; a refused host call keeps nothing (#637)
- **threads:** a thread's catch-up keeps an ask that mentions the agent (#507)
- **store:** a host's tool call passes the same write gate as a local one (#637)
- **threads:** a message has one topic, even while a commit is held (#637)

## 1.13.1 (2026-11-02)

### Fixes

- **blocks:** choose panels for wrapping options

## 1.13.0 (2026-11-02)

### Features

- **read-message:** read_message on an app gives its code, in parts, pinned to a version

### Fixes

- **read-message:** a part never ends inside a character; test the longer fence
- **runtime:** agents a message wasn't sent to get its attachments' paths
- **thread:** a diagram's listener goes with its frame; topic threads redraw for inherited terms

## 1.12.3 (2026-11-02)

### Fixes

- **remote:** classify launcher exits by status
- **kiro:** a session over the request size limit starts over with the usual catch-up
- **remote:** distinguish launcher startup failures

## 1.12.2 (2026-11-02)

### Fixes

- **remote:** a closed broker takes no reply or answer from Postbox (#426)
- **remote:** a closed broker starts no write, and close waits for the rest (#426)
- **remote:** broker.close waits for writes in flight, and the settle specs wait for it (#426)

## 1.12.1 (2026-11-02)

### Fixes

- **store:** every reader of a held or replayed event agrees on a rejected one (#632 review)
- **store:** replay names a commit's first rejected event, as the live path does
- **store:** a retry of a rejected commit is rejected again, not a duplicate success
- **store:** no producer may emit a stream frame's name either
- **store:** an event the reducer rejects is numbered, written and held as rejected (#609, #610)
- **state:** a reducer handler that throws changes nothing first (#609)

## 1.12.0 (2026-11-02)

### Features

- **state:** one event table decides what reaches the browser (#508)

### Fixes

- **state:** the browser boundary claims only what it enforces, and telemetry keeps public types
- **state:** freeze each event-table entry, and name the frozen switch a transcription

## 1.11.2 (2026-11-02)

### Fixes

- **server:** a failed stop of a deleted session's kept jobs is logged
- **adapters:** a stop that fails still ends the turn

## 1.11.1 (2026-11-02)

### Fixes

- **remote:** a host's change draws the rings that say where it runs, not every reply's
- **thread:** one rule finds an agent's latest reply, for its ring and its words
- **ring:** the ring beside an earlier reply says only whose it is
- **app:** a session change paints only the status words it can change
- **thread:** only an agent's latest reply's ring follows its session
- **ring:** a ring draws once for all the attributes a change sets

## 1.11.0 (2026-11-02)

### Features

- **508:** #582 part 1 remote read deadline and replay implementation
- **remote:** #582 part 3, an io seam for the broker's file calls, and the race specs T07 to T09
- **remote:** #582 part 3, one settle path for reads that can't reach Postbox

### Fixes

- **remote:** an offline answer reaches the shim before any journal write (#582)
- **remote:** driverLost does nothing on a closed broker, and a failed settle is logged (#582)
- **remote:** a reconnect during a reply's journal write still sends the call (#582)
- **remote:** a read is answered from the snapshot at once when its driving Postbox goes away (#582)

## 1.10.1 (2026-11-02)

### Fixes

- **lint:** lint-caps allows a new length rule only a level and a maxLines
- **lint:** lint-caps fails closed, and a new module gets no ceiling over the default
- **lint:** lint-caps fails a new module whose length rule is off
- **lint:** lint-caps counts a non-failing level as no limit, and reads ./ paths as one
- **lint:** lint-caps fails a nested Biome config, and a missing base in CI

## 1.10.0 (2026-11-02)

### Features

- **store:** store.pending reads a list with what is held behind a commit (#601)

### Fixes

- **ledger:** restore reads the file as the Work view shows it
- **store:** every read that decides a write reads pending, apps included (#601)

## 1.9.2 (2026-11-02)

### Fixes

- **work:** files' window buttons say later and earlier, as the other lists do
- **work:** a window around the item Work opened at moves with it
- **work:** choosing one agent's work draws its lists, not a stretch past their end
- **work:** full-screen Work draws its long lists 50 at a time
- **work:** a turn's list finds a patched entry by id, not by a scan of the ledger
- **work:** one turn's summary reads that turn's entries, not the whole ledger

## 1.9.1 (2026-11-02)

### Fixes

- **runtime:** endWork logs through console.error, as the rest of the server does
- **runtime:** a ledger that fails to end a turn is warned about, not left as an unhandled rejection
- **blobs:** a failed put removes its draft, and a put of existing bytes syncs the folder (#305)
- **blobs:** a failed folder sync rejects the put; only an unsupported one is ignored
- **blobs:** a blob is published whole through a synced draft, and kept private

## 1.9.0 (2026-11-01)

### Features

- **store:** ps start times off Linux, stale drafts swept, the lock’s refusal names the file
- **app:** the store’s status line, with Retry and the count of unsaved changes
- **runtime:** turns stop and wait while the store is closed, and what waited runs after Retry
- **mcp:** a tool that would write is refused with the cause while the store is closed
- **server:** the store’s status on the stream and state; a Retry route; writes refused while closed
- **store:** Retry reloads on a new epoch; a status for the page; a failed snapshot warns

### Fixes

- **store:** an orphaned session is found by its held stop record, not its exit
- **store:** a held wake's owner after Retry is decided by the recovered state
- **store:** one purge run at a time per persona; the reload drops owned work before reopening
- **store:** held work names its owner and the reload drops it; awaits re-check before acting
- **store:** a snapshot abandoned at close() records no warning that promises a retry
- **store:** close() re-reads what is under way until nothing new; a refused Retry says closing
- **store:** a reconcile is bound to its phase; stopKeptJobs fences its record after the await
- **store:** track every reload listener's lifetime; fence the persona purge after each forget
- **runtime:** gated timers defer, callbacks fence after awaits, a late reconciliation is tracked
- **runtime:** timers and pollers do nothing while the store is closed; Retry re-arms every timer
- **store:** close() always syncs the log, and a failed final sync keeps the lock and rejects
- **store:** close() past its bound keeps the lock and rejects; no-handle Retry latch spec
- **store:** close() draws its boundary before any await, drains with a bound, guards each step
- **store:** Retry checks for a close after each step, and close() waits for the writer’s pass too
- **store:** American spelling in a Retry comment
- **store:** close() waits for a Retry under way, and a Retry finds the store closed installs nothing
- **store:** Retry stays closed to outside writes while it reconciles, through an internal path
- **store:** Retry awaits the reload listeners’ commits before writes are announced open
- **store:** one start-time source, an epoch on each stream send, one stop path, the status first
- **store:** Retry on a store that never failed is a no-op, and the route answers 409

## 1.8.2 (2026-11-01)

### Fixes

- **queue:** report discarded holds on every purge
- **queue:** preserve held messages through send and purge
- **queue:** the purge logs what it dropped for a deleted agent; Retry in the window is held (#427)
- **queue:** hold what reaches an agent in its Undo window instead of dropping it (#427)
- **composer:** syncList keeps focus when a row leaves; Remove hands focus to the next row (#427)
- **queue:** Undo drains from the conversation, and no path delivers to an agent being deleted (#427)
- **queue:** Undo of a delete drains what the queue held back (#427)
- **composer:** no repaint takes focus; Cancel, Save and Escape keep it on the row (#427)
- **queue:** release a deleted agent's messages at the purge, so Undo finds them queued (#427)
- **queue:** a leaving agent's queued messages post to the thread; focus survives (#427)
- **composer:** queue buttons name their message; one helper lists a conversation's threads (#427)
- **composer:** a waiting line, capped offline rows, and a dialog that never loses focus (#427)
- **composer:** queued messages for busy agents move to agent mail (#427)

## 1.8.1 (2026-11-01)

### Fixes

- **runtime:** Stop and a turn's end mark the open segment by id, even held behind a commit
- **runtime:** Stop always leaves the reply saying it was stopped

## 1.8.0 (2026-11-01)

### Features

- **store:** Retry is a reload into a private candidate, installed after a fresh-descriptor sync
- **store:** a history epoch the page echoes, so a restart resyncs it
- **store:** one store per data folder, held by a lock file
- **store:** write a commit as one fsynced line and recover it

### Fixes

- **store:** close() sets its boundary first and waits for the writer; no snapshot outlives the lock
- **store:** close for good, commits resolve their last seq, the folder syncs at start
- **store:** a lock or takeover file is published whole, and unreadable contents prove nothing
- **store:** the takeover mutex names its maker and is never reclaimed for its age
- **store:** a stale takeover mutex is moved aside before it goes, so one of two starters removes it
- **store:** lock takeover, snapshot pieces, queued opId repeats and flush failures hold up
- **store:** a failed commit gives back the numbers it took, so later emits follow the applied seq
- **store:** a failed write closes the store to commits until a restart; the reload moves to 1b

## 1.7.2 (2026-10-31)

### Fixes

- **adapters:** share the fresh-start notice and explain Codex error matching
- **codex:** recover when a saved thread has no rollout

## 1.7.1 (2026-10-31)

### Fixes

- **codex:** deliver Postbox instructions through the thread protocol

## 1.7.0 (2026-10-31)

### Features

- **uat:** snapshot stall benchmark and log-based UAT tooling (#508)

### Fixes

- **uat:** address integrator review on PR #578 (#508)
- **transcript:** the thread panel notes its composer shrinking, as the conversation does
- **composer:** a growing draft in the thread panel keeps its newest message above the composer
- **uat:** measure loop delay accurately and harden stall benchmark (#508)
- **transcript:** a reply in the frame you scroll up in counts as unseen
- **transcript:** a shrink beside the transcript no longer reads as scrolling up
- **composer:** a draft that grows at the end keeps the newest message above the composer

## 1.6.0 (2026-10-31)

### Features

- **remote:** remote read contract and protocol 3 fallback (#530)

## 1.5.0 (2026-10-31)

### Features

- **projects:** set the repository a push you ask for goes to, in Settings
- **permissions:** Postbox makes a push the person asked for itself, by its consequence
- **permissions:** a git push comes to Postbox as a write outside
- **permissions:** a git push comes to Postbox as a write outside

### Fixes

- **permissions:** Postbox's push reads only its own repository, never one planted in temp
- **permissions:** a write's card names every place its command writes
- **permissions:** a write's card names every place its command writes
- **permissions:** only a plain git push goes to the request check

## 1.4.0 (2026-10-30)

### Features

- **permissions:** judge any call in Auto against the person's request
- **permissions:** a gh write the approved block names runs without a card

### Fixes

- **permissions:** no git command runs on request; only gh and MCP calls can
- **permissions:** a git command on request keeps its card when its config, hooks or target say so
- **permissions:** a request never publishes a variable, a dotfile or a file a link leads out to
- **permissions:** the person's own ask rules keep their card, and a negated quote counts for nothing
- **permissions:** the request floor matches names whole, limits MCP fields and git flags
- **permissions:** only the person's typed words or an exact confirm count
- **permissions:** an allow-list in code decides what a request may cover

## 1.3.0 (2026-10-30)

### Features

- **uat:** record where a run's time goes, per step and in all

### Fixes

- **uat:** when one verifier pass throws, wait for the other before rethrowing
- **uat:** on a tight --max-cost, the second verifier call waits instead of being refused
- **uat:** read a wait a phase names as "in two minutes"
- **uat:** a recheck keeps the live run's timing in its report
- **uat:** cap a tester-chosen wait at 30 s and end it once the agents settle
- **uat:** verify closed-issue findings and new findings at once

## 1.2.0 (2026-10-30)

### Features

- **uat:** telemetry report keeps unverified rows with check ids and counts

## 1.1.3 (2026-10-30)

### Fixes

- **thread:** an activity step repaints only its reply's activity list

## 1.1.2 (2026-10-30)

### Fixes

- **reactions:** draw the light theme's icon rim into the icons, not as a filter on each
- **transcript:** find the reply across the middle by halving, not from the top

## 1.1.1 (2026-10-30)

### Fixes

- **apps:** a check overtaken by a newer version stops, so the new one starts at once

## 1.1.0 (2026-10-30)

### Features

- **uat:** marker-before-output says it can’t check an agent on Codex, Kiro or Antigravity
- **uat:** the delivery checks say a topic thread’s mentions aren’t checked, rather than nothing
- **uat:** `- chain-limit: N` sets the chain limit of the run’s Postbox (POSTBOX_CHAIN_LIMIT)
- **uat:** --phases plays only the chosen phases and checks only their triggers
- **uat:** keep the agents' transcript lines the checks read in the run folder, for --recheck
- **uat:** wire #508's big-room seed and fault launcher into the runner
- **uat:** add the big-room seed's generated room
- **uat:** add the fault launcher that fails a turn before any output
- **uat:** add #508's delivery checks and triggers

### Fixes

- **uat:** marker-before-output exempts only a stopped turn; a saved prompt isn't delivery
- **uat:** unlabeled-repeat exempts Retry’s resend, which sends the same message again by design
- **uat:** marker-before-output skips a stopped turn, and one whose prompt reached the transcript
- **uat:** ask-dropped skips a held wake Stop, archive or removal took off its card by design
- **uat:** delivery-dropped matches a short message by its whole text, and says when it can’t tell it
- **uat:** the chain-limit setting can only lower the backstop, to a whole number from 1 to 50
- **uat:** delivery checks don't judge a turn still running as ended
- **uat:** delivery-dropped waits for a held mention's card to settle
- **uat:** edit-while-waiting serves AT-6 as well as DL-7
- **uat:** unlabeled-repeat leaves every same-text item a prompt could belong to unverified
- **uat:** ask-dropped follows a held wake a retired card moved to the next card
- **uat:** unlabeled-repeat counts a prompt only for the item it names or whose window it's in
- **uat:** edit-while-waiting matches the whole edited text, and only after the edit
- **uat:** seed the big room's review as approved, so needs-mismatch doesn't fire on the seed
- **uat:** say a delivery check can't read a turn with no recorded transcript
- **uat:** say when a delivery check can't read an agent's inputs
- **uat:** key deliveries by item id so two alike messages stay two
- **uat:** treat a topic thread's starting message as labeled, not a repeat
- **uat:** don't count Claude Code's compaction summary or meta lines as prompts

## 1.0.1 (2026-10-30)

### Fixes

- **thread:** defining a glossary term redraws only the replies that use it

## 1.0.0 (2026-10-30)

### Breaking changes

- **readme:** going back to a build before session.patch isn’t supported

### Features

- **agents:** a constant system prompt, and each turn opens with its request
- **store:** a session's changes travel as session.patch, with only the fields that changed

### Fixes

- **agents:** folded lint has its own place in the turn, after the request and before the background
- **uat:** readReceived applies session.patch, so the hostwakes checks see delivered wakes again
- **rings:** a working ring moves as one overlay, so the page isn't repainted each frame

## 0.44.9 (2026-10-30)

### Fixes

- **wakes:** one show_app call is one tool in a scheduled wake's recovery
- **wakes:** a scheduled wake's recovery keeps other MCP servers' names on their tools
- **wakes:** a react a scheduled turn calls counts toward its recovery
- **wakes:** a scheduled wake's host turn waiting or lost at a restart isn't started a second time
- **wakes:** a restart leaves a scheduled wake to a host turn only when that turn is its own
- **wakes:** a scheduled wake queued behind a turn at shutdown stays due for the restart
- **wakes:** a scheduled wake queued behind a turn you stop is settled, not left running
- **wakes:** every backend's Postbox tool calls count toward a scheduled wake's recovery
- **wakes:** a restart in a scheduled turn whose tool started sends the recovery, not the instruction
- **adapters:** kiroError types its cause, so the type check passes
- **wakes:** your Stop ends a scheduled wake, so a restart doesn't run it again
- **wakes:** one tool call reported twice is one entry in a scheduled wake's recovery
- **wakes:** a Retry after you cancel a tool-aware recovery still sends the recovery
- **wakes:** keep retry state authoritative
- **wakes:** leave lost host turns to reconnect
- **wakes:** bound network retry attempts
- **wakes:** recover scheduled checks after network loss

## 0.44.8 (2026-10-30)

### Fixes

- **adapters:** Codex and Antigravity tool calls reach the work ledger

## 0.44.7 (2026-10-29)

### Fixes

- **server:** the chain limit stays as a backstop at 50, and a chain that ends starts its count again
- **server:** no chain limit either; no wake waits on a card for a limit
- **server:** no wake limit between two agents; the composer shows the chain's count instead

## 0.44.6 (2026-10-29)

### Fixes

- **runtime:** every failed item carries whom earlier failures woke (#485)
- **adapters:** keepShape narrows on its argument, so the typecheck passes (#485)
- **adapters:** a result that repeats streamed Markdown isn't posted again (#485)
- **adapters:** an empty reply keeps its stream's shape, not its text (#485)
- **runtime:** a slash turn may end quietly, and Retry skips agents already woken (#485)
- **runtime:** a host turn that goes on wakes its mentions when it ends (#485)
- **runtime:** a failed reply's @-mentions wake their agents, marked as failed (#485)
- **adapters:** post a result's text when no text event carried it (#485)
- **runtime:** a Postbox call that acts counts as the turn's answer (#485)
- **runtime:** other agents read a failed reply's text, marked as failed (#485)
- **runtime:** a turn that ends without a reply says so, with Retry (#485)

## 0.44.5 (2026-10-29)

### Fixes

- **adapters:** preserve permission summary whitespace
- **checks:** normalize remaining Claude blocks
- **adapters:** normalize Claude message content blocks

## 0.44.4 (2026-10-29)

### Fixes

- **uat:** a retired wake card stops waiting when it was retired
- **uat:** file host-wake-said-sent against #439
- **uat:** readReceived reads on from where it got to in the store's log
- **uat:** host-wake-said-sent's evidence claims only what it checked
- **uat:** count a card asking to add an agent, which refuses wakes too
- **uat:** a card isn't counted against the wake_agent call that raised it
- **uat:** match a wake's target without case, as Postbox does
- **uat:** refused-wake-lost judges host-mode runs only
- **uat:** a declined wake card no longer reads as waiting for good
- **uat:** match hostwakes calls on what the target received, not on what's posted
- **uat:** judge a hostwakes hand-off lost by whether Postbox delivered it
- **uat:** count a held hand-off as delivered only when Postbox posts its message
- **uat:** don't count the person's turns as a hostwakes sender told of its refusal
- **uat:** tell a refused wake_agent call by the message Postbox didn't post

## 0.44.3 (2026-10-29)

### Fixes

- **threads:** distinguish missing thread tasks
- **threads:** cover every kind of thread turn
- **threads:** put a topic request before room context

## 0.44.2 (2026-10-29)

### Fixes

- **threads:** keep CJK and long tokens in glimpses
- **threads:** retain spaces across streamed glimpses
- **threads:** bound glimpse sentence scans
- **threads:** show whole-sentence thinking glimpses

## 0.44.1 (2026-10-29)

### Fixes

- **review:** use preview width for detailed drafts

## 0.44.0 (2026-10-29)

### Features

- **personas:** delete an agent, with Undo, and its memory with it (#208)

### Fixes

- **personas:** the purge skips an erased session; session Undo waits for its persona's (#208)
- **personas:** a purge cut short by a restart starts again (#208)
- **personas:** the delete sheet goes back after 3 s if the stream misses the delete (#208)
- **agents:** the overview says when Claude Code is too old to keep a memory per agent (#208)
- **personas:** refuse a session for a persona being deleted, and purge it whole (#208)
- **personas:** attaching a terminal session names around a persona being deleted (#208)
- **personas:** finish a persona delete pending at a restart, and hold its name until then (#208)
- **adapters:** each Claude Code and Agent SDK persona keeps its own memory (#208)

## 0.43.3 (2026-10-29)

### Fixes

- **apps:** keep every on-screen app running
- **apps:** parse apostrophes in unquoted attributes
- **apps:** ignore duplicate browser checks
- **apps:** pause unused frames and queue one check
- **apps:** preserve visible apps during checks
- **apps:** preserve Unicode offsets while scanning scripts
- **apps:** scan malformed script end tags safely
- **apps:** check every pending app safely
- **apps:** locate sandbox script errors
- **apps:** report stylesheet class collisions

## 0.43.2 (2026-10-29)

### Fixes

- **uat:** the verifier's prompt counts its three readings
- **uat:** the verifier reads what a wake's answer means, and judges a finding's own claim
- **uat:** the verifier can search a run's records, and is told what they hold
- **uat:** the runner's flag reactions use the inline buttons

## 0.43.1 (2026-10-29)

### Fixes

- **remote:** a rejection nothing handled on a host is logged, and its daemon keeps serving
- **server:** a rejection nothing handled is logged, and Postbox keeps running

## 0.43.0 (2026-10-28)

### Features

- **server:** agents cancel their own scheduled wakes with cancel_wake

### Fixes

- **remote:** a host call Postbox waits on is applied once, though the daemon sends it again
- **adapters:** cancel_wake is a quiet Postbox tool, with its own step label

## 0.42.3 (2026-10-28)

### Fixes

- **server:** two mentions at their bound both fit a turn's summary
- **server:** a message that mentions an agent reaches its summary whole, up to 16,000 characters

## 0.42.2 (2026-10-28)

### Fixes

- **server:** a summary that keeps an old mention doesn't call what it kept the last N
- **server:** the pointer to a mention a summary gave names the call that reads it whole
- **server:** the skip a turn's summary names reaches the newest mention it left out
- **server:** cap the mentions a summary keeps, and quote a seen mention's start
- **server:** a turn's summary keeps every mention of the agent, and says what it left out

## 0.42.1 (2026-10-28)

### Fixes

- **server:** your message to a card's target goes before the card's own wake
- **remote:** a host call Postbox waits on is applied once, though the daemon sends it again
- **app:** a retired wake card says its message went on, or asks again
- **server:** a retired wake card records when it was retired
- **server:** a retired wake card's own hand-off goes on, as its held wakes do
- **server:** Stop and archive reach a wake held on a card
- **server:** retire a wake card whose target got a turn another way
- **server:** hold a wake that needs a card while one waits, and settle it with that card

## 0.42.0 (2026-10-28)

### Features

- **agents:** subagents collapse into the agent's ring, with a toggle to list them (#477)

### Fixes

- **agents:** a subagent's row shows its step, not its narration or thoughts (#476)
- **agents:** a ring's +N no longer runs under the agent's name (#475)

## 0.41.13 (2026-10-28)

### Fixes

- **blocks:** keep raw fallback open on updates
- **activity:** keep expanded steps through updates
- **review:** keep unfinished comments through updates

## 0.41.12 (2026-10-27)

### Fixes

- **telemetry:** record activity steps incrementally

## 0.41.11 (2026-10-27)

### Fixes

- **guide:** tell Codex agents how to write to the room

## 0.41.10 (2026-10-27)

### Fixes

- **markdown:** pin escaped LaTeX closers
- **markdown:** scan LaTeX math delimiters once

## 0.41.9 (2026-10-27)

### Fixes

- **codex:** leave Auto's MCP calls to Codex's own reviewer, as on main
- **codex:** apply MCP policy to every permission mode
- **codex:** address MCP policy override paths
- **codex:** separate consecutive reply messages
- **codex:** finish web search activity
- **codex:** ask before third-party MCP tools

## 0.41.8 (2026-10-27)

### Fixes

- **kiro:** send remote prompts through stdin
- **kiro:** move host privacy warning to setup
- **reactions:** show an agent-only reaction count
- **shell:** mark the current project in places

## 0.41.7 (2026-10-27)

### Fixes

- **blocks:** reopen identical answered updates
- **blocks:** an outcome isn't a new revision, and agents no longer set one
- **blocks:** record an outcome from { id, outcome }, and show a review's real revision

## 0.41.6 (2026-10-26)

### Fixes

- **guide:** preserve existing app check guidance on review
- **apps:** report saved versions and readable browser check status

## 0.41.5 (2026-10-26)

### Fixes

- **adapters:** take a turn's tokens from its own usage, and leave a fork's cost unknown
- **ring:** draw no arc for an unknown context, and move its dot instead
- **ring:** show a subagent's unreported context as unknown, not 0%
- **adapters:** count a resumed Claude Code turn's own spend, not the session's

## 0.41.4 (2026-10-26)

### Fixes

- **permissions:** give a rule only to what it can't widen (#281)
- **permissions:** read the program by its name, and its script by path
- **permissions:** no broad rule for code given on the command line
- **permissions:** no rule wider than the command the card showed

## 0.41.3 (2026-10-26)

### Fixes

- **blocks:** tick only progress blocks with a step still running
- **transcript:** hold the ring beside each message still, so a long conversation stops repainting

## 0.41.2 (2026-10-26)

### Fixes

- **agy:** write the refusal notes when the hook doesn't check out, and say a call may ask
- **agy:** stop telling Antigravity agents their calls are refused when the hook asks for them

## 0.41.1 (2026-10-26)

### Fixes

- **markdown:** scan link delimiters once

## 0.41.0 (2026-10-26)

### Features

- **adapters:** approve writes outside Postbox through MCP and gh in Antigravity's Auto
- **adapters:** let Postbox's hook approve routine Antigravity calls in Auto

### Fixes

- **adapters:** leave web searches to the reviewer in agy's Auto, and match the persona spec
- **adapters:** leave gh writes, MCP tools and fetches with a query to the card in agy's Auto
- **adapters:** match .git and the hook's own files without case, and keep jq out of Auto
- **adapters:** stop options and the folder's own code passing as routine in Antigravity's Auto

## 0.40.4 (2026-10-26)

### Fixes

- **tools:** let SIGTERM and SIGHUP end a screenshot run, as before Playwright
- **uat:** kill Chromium when its close hangs, so a run's stop reaches Postbox
- **lint:** check page code passed to frameOf, as to evaluate and waitFor
- **uat:** drive Chromium through Playwright, so a killed run leaves no browser

## 0.40.3 (2026-10-26)

### Fixes

- **guide:** keep schedule_wake's description as on main
- **guide:** tell only Codex agents their turn ends when they reply
- **guide:** tell agents their turn ends when they reply

## 0.40.2 (2026-10-26)

### Fixes

- **composer:** say when @handle /command names no agent here
- **composer:** run @agent /command for the agent it names

## 0.40.1 (2026-10-26)

### Fixes

- **server:** remove startup error listener after bind
- **server:** a start() that can't bind its port closes what it opened
- **needs:** ⌃J tells the transcript about its scroll at once

## 0.40.0 (2026-10-26)

### Features

- **codex:** say on the persona sheet that Auto is Codex's own reviewer
- **codex:** let Codex's own reviewer decide in Auto, as Claude Code's classifier does

## 0.39.0 (2026-10-26)

### Features

- **adapters:** add Gemini 3.8 Flash 1M context window to cited models

### Fixes

- **adapters:** cite Gemini 3.8 Flash's window, 1,048,576 tokens

## 0.38.1 (2026-10-26)

### Fixes

- **codex:** pass a local folder to Codex by its real path

## 0.38.0 (2026-10-26)

### Features

- **personas:** add a GPT boilerplate using Codex

### Fixes

- **seed:** preserve boilerplates on the first start after merging main
- **codex:** discard unoffered Claude models when switching backends
- **personas:** require a confirm block for destructive or costly actions
- **codex:** label the backend default without a false model mismatch
- **personas:** describe all built-in boilerplates in the add menu
- **personas:** align GPT publishing with the agent contract
- **codex:** omit the unoffered Claude model fallback

## 0.37.1 (2026-10-26)

### Fixes

- **adapters:** treat a token count that isn't a finite number as unknown context

## 0.37.0 (2026-10-26)

### Features

- **remote:** give each host turn's shims a token of their own
- **remote:** carry a message's attachments in start, onto the host's turn folder
- **uat:** run agents on other machines over ssh, with the remotehosts scenario
- **uat:** drive the Hosts tab and Runs on as a person sets a host up
- **uat:** remote-aware checks and host-mode triggers
- **remote:** show hosts, where agents run and their remote turns' states; keep host files local
- **remote:** run a persona's turns on a host from the runtime, with states, resume and restart
- **remote:** serve Postbox's tools on a host, install its daemon, and run the harnesses there
- **remote:** run turns on a host through a daemon, a runner and a shim
- **remote:** lay the foundations for agents on remote hosts

### Fixes

- **agents:** say when /mode changed a running turn at once
- **remote:** admit a host turn's queued calls one at a time, so its shims can't pass the cap
- **remote:** drop the POSTBOX_REMOTE_HOME test hook from the host's code
- **remote:** a host card answered Allow just as the host gave up says it expired, not Allowed
- **remote:** put an urgent note first in a host call's answer, as on this computer
- **hosts:** refuse a host destination with spaces around it, rather than trim it
- **personas:** tie Runs on's errors to its select
- **hosts:** Remove's confirm says what stays, focuses Cancel first, and hands focus on after
- **permissions:** say in the panel that an agent on a host reads the host's settings files
- **remote:** cap a host turn's calls waiting for Postbox, and its record of them
- **remote:** hear a turn's messages only from the host it runs on
- **mcp:** export TOOL_DEFS from server/mcp.mjs again
- **remote:** keep ~/.ssh/config's forwards, X11, LocalCommand and host-key policy off Postbox's ssh
- **remote:** offer no Always allow on a host turn
- **uat:** refuse a host where Postbox is installed, unless --replace-host-install
- **remote:** give a host prompt's stored answer back only to the request it answered
- **uat:** a run's stop waits until its Chrome and Postbox have exited
- **checks:** splice values into the host checks' page code through js()
- **remote:** compare a host's token in constant time, and say why ssh's failure pattern is safe
- **uat:** click a host field again until it has focus
- **checks:** drop the test Chrome's background flags now that main emulates focus
- **remote:** continue a turn on its host as the turn it was, through restarts and Retry
- **remote:** keep thread.mjs under main's ceiling, and count a host's edits in Work's check
- **remote:** let a host take its own Postbox back after a dropped ssh
- **uat:** after Stop on a host, count what's left running in the run's folder
- **remote:** end a host's connection when ssh exits, and stop what it started
- **uat:** count a fault only when the host was seen cut off
- **uat:** give a scenario's permission mode to agents on Claude Code too
- **uat:** clean hosts up only by confirmed outcomes, on Ctrl-C too
- **remote:** give a host just added its status, so its card offers Install…
- **remote:** connect a host when the person installs, retries or reconnects
- **remote:** keep an answer given as Postbox shuts down, rather than crash
- **remote:** point an agent on a host at its copy of each attachment

## 0.36.4 (2026-10-26)

### Fixes

- **security:** run the scan's judge through a symlink, and choose it by what it does
- **check:** repeat a spec a retarget or merge brings in, and trust only Actions' own pass

## 0.36.3 (2026-10-26)

### Fixes

- **queue:** deliver refreshed context instead of dropping waiting handoffs
- **queue:** recheck pending batches before starting their turn
- **queue:** deliver queued wakes together and discard superseded requests

## 0.36.2 (2026-10-26)

### Fixes

- **adapters:** render context unknown on quick panel and initialize sessions at null ctx (#392)
- **adapters:** clear unknown context and cite Gemini 4 Argon window (#392)
- **adapters:** align Codex token usage shape and cite model context windows (#392)
- **adapters:** report active context usage for Antigravity and Codex (#392)

## 0.36.1 (2026-10-25)

### Fixes

- **agents:** match a running turn to its own conversation in the mode note
- **agents:** say when a running turn keeps its old permission mode
- **permissions:** let run everything answer only codex's own sandbox asks
- **permissions:** honor run everything in a turn that's already running

## 0.36.0 (2026-10-25)

### Features

- **adapters:** ask with a permission card via PreToolUse hook on Antigravity CLI (#370)

### Fixes

- **mcp:** match disconnected permission_prompt card by tool_use_id (#370)
- **adapters:** expire open permission card on disconnect and set agy hook floor to 1.4.7 (#370)
- **adapters:** use node:http without a 300s headers timeout in agy-hook (#370)

## 0.35.1 (2026-10-25)

### Fixes

- **ci:** call cancelled() only in an if, so the prompt gate runs again

## 0.35.0 (2026-10-25)

### Features

- **personas:** add the Gemini persona boilerplate

### Fixes

- **personas:** prefer b.model, disable unavailable boilerplates and keep seed order

## 0.34.0 (2026-10-25)

### Features

- **threads:** agents talk in the conversation; side threads are read-only

### Fixes

- **threads:** count each pair's wakes, and every wake a message makes
- **demo:** play the wake scene in the conversation

## 0.33.6 (2026-10-25)

### Fixes

- **settings:** its tabs wrap on a phone, so the dialog no longer scrolls sideways

## 0.33.5 (2026-10-25)

### Fixes

- **state:** the second id in a route is checked too, and the test reaches every route
- **state:** an id is a record the state has or nothing, never Object's prototype

## 0.33.4 (2026-10-25)

### Fixes

- **runtime:** an app's waiting card keeps its agent needing you through its turns

## 0.33.3 (2026-10-25)

### Fixes

- **server:** missing or bare static folders answer 404, and page files go through servedFile
- **ledger:** record a SHA-256 repository’s commits, whose shas are 64 hex
- **ledger:** git reads ignore commands a repository’s config names
- **server:** serve static files only from inside their folders, through links too
- **side-threads:** refuse a wake_agent message or post past 50,000 characters
- **datasets:** refuse a datasets folder that links out of the project
- **corpus:** hold corpus_search to 1–50 results and its first 50 book ids
- **mcp:** compare a tool call’s turn token in constant time
- **ledger:** refuse a commit sha that isn’t hex before it becomes git’s argument

## 0.33.2 (2026-10-25)

### Fixes

- **thread:** note a clamp only when it left the view at the page's end
- **thread:** keep the view on what you read when the page changes under it

## 0.33.1 (2026-10-25)

### Fixes

- **deps:** move sharp to 0.35.5 and body-parser to 2.4.0
- **uat:** pick canary words with randomInt, not a byte modulo the list
- **uat:** escape backslashes in report table cells
- **markdown:** strip tags in one place, until none is left
- **markdown:** close a fence by comparing its run, not a regular expression built from text

## 0.33.0 (2026-10-25)

### Features

- **archive:** sessions are archived and deleted with their conversation; nothing archives itself
- **wakes:** raise the wake limit from 3 to 10
- **shell:** ring-only to the ask, and no overview, Archived page or top-bar rings
- **reactions:** all five inline beside Reply in thread, with who reacted

### Fixes

- **shell:** deleting a conversation's only agent leaves it, not back into it
- **css:** the live regions don't make the page taller than the app

## 0.32.4 (2026-10-25)

### Fixes

- **uat:** keep the checkout's AGENTS.md from the tester and verifier too
- **uat:** keep the checkout's AGENTS.md out of a run's Claude Code agents

## 0.32.3 (2026-10-25)

### Fixes

- **permissions:** bound the command scan's work, and read a backslash-newline out of each part
- **uat:** the allow-once triggers import the scanner from shared/
- **permissions:** read a command's parts as the shell does for the write guard

## 0.32.2 (2026-10-25)

### Fixes

- **shell:** a waiting agent's ring and row don't say they open a dialog, or whether one is open
- **shell:** a menu closed before it listened no longer closes every later menu

## 0.32.1 (2026-10-25)

### Fixes

- **permissions:** read a backslash-newline and escaped quotes around a heredoc as the shell does
- **permissions:** read a heredoc's word as the shell does, so a quoted or dashed one isn't chained
- **permissions:** no Allow once or Always allow for a chained command, which no rule can match

## 0.32.0 (2026-10-25)

### Features

- **shell:** a needs-you ring or row goes to that agent's ask, and ⌃J lands reliably

### Fixes

- **shell:** leave modifier clicks and the top bar's ring stack to their own behavior
- **checks:** a headless check that recorded no case fails
- **checks:** keep headless Chrome's page focused, so an Escape doesn't freeze it

## 0.31.0 (2026-10-25)

### Features

- **uat:** cap a whole run's cost with --max-cost, and stop it with its report

### Fixes

- **uat:** count each resumed session's cost once

## 0.30.2 (2026-10-25)

### Fixes

- **uat:** honor send_then_stop's delay and hand the job question to the tester
- **stop:** settle a stopped turn's running steps, and its reply's header

## 0.30.1 (2026-10-24)

### Fixes

- **agents:** shorter setup guidance, safe in bypass mode, and none in agy's full rules file
- **agents:** ground setup diagnosis in evidence
- **uat:** count filed findings in recurrence

## 0.30.0 (2026-10-24)

### Features

- **reactions:** switch to the person's final icon set

## 0.29.0 (2026-10-24)

### Features

- **threads:** Summarize back from a side thread, as from a topic thread
- **composer:** ask “Did you mean @critic?” when a draft names an agent without its @

### Fixes

- **composer:** shorter thread hints, so a thread's composer sits as high as the conversation's
- **threads:** a summary's review_block wakes no one either
- **threads:** keep a queued summary pending while its turn starts
- **threads:** say on the sender line when a scheduled wake started the turn
- **threads:** give each wake an agent sends from another turn its own sender line
- **telemetry:** count agents' wake chains from each wake's message, now that wakes have no line
- **threads:** one line per side thread in the conversation, not one per wake
- **composer:** say whom a message that mentions an agent wakes, not who it replies to
- **thread:** give a later turn of the same agent its own sender line, with what woke it

## 0.28.1 (2026-10-24)

### Fixes

- **permissions:** expire a permission card a minute before Claude Code gives up on the call
- **permissions:** offer permission_prompt only to the CLI, and expire a card at 25 hours
- **permissions:** a tool card answers itself when the tool is turned on elsewhere

## 0.28.0 (2026-10-24)

### Features

- **overview:** give a card that needs you a look of its own

### Fixes

- **look:** light mode keeps its fills, and focus-clear places its message under the composer
- **contrast:** check the app's stylesheet when none is named
- **a11y:** keep what has focus clear of the sticky composer
- **ui:** mark every text button as a control, with a border or an underline
- **composer:** line up the thread panel's composer with the conversation's
- **ui:** give boxes that wrap a card's corners, not pill ends
- **ui:** show selected segments, chosen chips and on toggles as amber outlines

## 0.27.1 (2026-10-24)

### Fixes

- **threads:** space a shared reply's question as a message is
- **threads:** draw a shared reply's question apart from its answer
- **threads:** keep the question with shared replies

## 0.27.0 (2026-10-24)

### Features

- **reactions:** let agents react to any message, their own included

### Fixes

- **reactions:** flag-misplaced counts only the runner's own 🚩, and two window comments
- **reactions:** say "you" in words on a shared chip, and the review's telemetry and UAT fixes

## 0.26.0 (2026-10-24)

### Features

- **reactions:** draw each reaction with its icon

### Fixes

- **reactions:** the UAT's telemetry driver finds a reaction by its icon, and every icon is checked

## 0.25.1 (2026-10-24)

### Fixes

- **stop:** four review fixes: a stopped kept job, Send now's sender, shared groups, a stray kill
- **stop:** a stopped reply's tag grows to two lines where its words wrap, not out of its pill
- **stop:** stopping one of two kept jobs that share processes ends the other as stopped
- **stop:** say why a reply stopped, and tell the agent its kept jobs weren't stopped

## 0.25.0 (2026-10-24)

### Features

- **telemetry:** record every UAT run, and put Telemetry in Work's place
- **telemetry:** keep recordings per conversation, bound the classifier, and prove the gate
- **telemetry:** open the report in a Telemetry view beside the room
- **telemetry:** record a room, and gate its report, unlisted

### Fixes

- **telemetry:** a clone on its own data/ can't record, per the person's ruling on #239
- **telemetry:** the fourth review's findings on #239
- **telemetry:** the third review's findings on #239
- **telemetry:** the second review's findings on #239
- **telemetry:** the review's page findings on #239, and a browser check
- **telemetry:** the review's server findings on #239
- **telemetry:** react 🚩 once per item at the end of a UAT run
- **telemetry:** fixes from the first UAT runs
- **telemetry:** read only Postbox's own tool results in recording-visible

## 0.24.0 (2026-10-24)

### Features

- **review:** let an agent comment on another agent's review block
- **review:** preview a draft whole, comment on a selection, and go wide or full screen

### Fixes

- **review:** the block's agent can't rewrite or drop a reviewer's comments in a thread it sends back
- **review:** a click on an image that failed to load opens Lines at its line
- **review:** refuse a revision that would push a reviewer's kept thread past 200
- **review:** keep focus on the Comment button when the selection is heard again
- **review:** draw a review's Markdown images

## 0.23.0 (2026-10-24)

### Features

- **glossary:** link terms inside a definition, and stack their hover cards

### Fixes

- **blocks:** an escape before a carriage return no longer makes the highlighter backtrack
- **thread:** draw math, diagrams and glossary terms in a reply shared back from a thread
- **blocks:** show the code block's filename in its header, and highlight its code

## 0.22.0 (2026-10-24)

### Features

- **threads:** react to a message with an emoji, and the agent hears it as feedback

### Fixes

- **threads:** tell a thread's reactions to its own agents, and keep the review's fixes

## 0.21.0 (2026-10-24)

### Features

- **uat:** --force-agent-model runs a models: persona scenario on the run's model

## 0.20.0 (2026-10-24)

### Features

- **pane:** reopen a thread left open when you come back to its conversation
- **pane:** resize the right pane from a handle on its left edge
- **pane:** hide the sidebar while the right pane needs its room

### Fixes

- **pane:** an honest sidebar button beside the pane, and widths without the scroll bar
- **pane:** keep the sidebar button true, and the sidebar out of the pane's way
- **pane:** keep the conversation column usable beside the right pane

## 0.19.0 (2026-10-24)

### Features

- **agents:** End on a subagent's row tells its agent to stop it

### Fixes

- **side-threads:** one session per agent per conversation, and no forks

## 0.18.0 (2026-10-24)

### Features

- **work:** list what each turn did under its last reply, each row opening Work at it

### Fixes

- **work:** say which time the reply's activity line and the turn's list show
- **ledger:** record commits and branches a command makes, from git before and after it

## 0.17.0 (2026-10-24)

### Features

- **apps:** agents retire an app they no longer need with retire_app

### Fixes

- **apps:** the integrator's review fixes for retiring apps and the app check
- **kit:** review fixes for the text and control checks
- **apps:** review fixes for retiring an app
- **kit:** the app check finds controls you can't see or click
- **kit:** the app check finds text that spills out of its box or over other text

## 0.16.0 (2026-10-23)

### Features

- **blocks:** agents withdraw a block that asks, and the person can dismiss one

### Fixes

- **a11y:** screen readers hear replies as plain text, with dots in words kept
- **markdown:** \(…\) and \[…\] are math, not escaped brackets
- **markdown:** $$…$$ on one line is display math
- **blocks:** Postbox's own images load at localhost, and a failed image says so
- **blocks:** tell a topic thread's agent that its conversation's block is there

## 0.15.0 (2026-10-23)

### Features

- **side-threads:** send a side-thread message to the conversation, yourself or by an agent
- **threads:** the Threads page lists side threads beside topic threads

### Fixes

- **side-threads:** a failed side-thread turn shows on its line, with Retry, and opens at its card
- **side-threads:** the side-thread line counts every message there

## 0.14.0 (2026-10-23)

### Features

- **uat:** print recurrence by issue in uat-stats

### Fixes

- **uat:** count a closed issue's recurrence only after it closed
- **uat:** count only a closed issue's regressions as its recurrence
- **uat:** read a draft that asks to go out, and a list put to the person
- **uat:** catch an updated app its last version didn't move
- **uat:** one regression comment per issue per run, only while it stands
- **uat:** comment a regression a later filing pass finds, and never preset when gh fails
- **uat:** verify a closed issue caught again against its fix
- **uat:** stop #63's check flagging reports and exercise answers
- **uat:** read moved blocks and apps in #123's and #49's checks

## 0.13.2 (2026-10-23)

### Fixes

- **adapters:** let a permission card wait a day on the Claude Code CLI

## 0.13.1 (2026-10-23)

### Fixes

- **adapters:** a failed Codex turn says why, from the error Codex reported
- **adapters:** a folder an agent can't work in says so, not that the CLI is missing
- **store:** a reconnecting browser no longer doubles a reply that was streaming

## 0.13.0 (2026-10-23)

### Features

- **agents:** show subagents' narration, thinking and hierarchy in the agent tree

### Fixes

- **agents:** Monitor and other background tools are jobs, and a step after a kept job runs on

## 0.12.0 (2026-10-23)

### Features

- **overview:** archive a whole conversation, and idle ones after 7 days
- **overview:** lead with what needs you, and list idle conversations as rows

## 0.11.0 (2026-10-23)

### Features

- **package:** install and run Postbox as an npm package
- **server:** keep the person's data and media in ~/.postbox

## 0.10.2 (2026-10-23)

### Fixes

- **shell:** clip the version menu's second line with an ellipsis too
- **shell:** label Work, fit long menus, and keep the folder picker usable around links

## 0.10.1 (2026-10-23)

### Fixes

- **shell:** the top bar keeps focus on its control when it repaints

## 0.10.0 (2026-10-23)

### Features

- **agents:** the room tells each agent who else is here, what each does, and how to share the work

### Fixes

- **personas:** shorter seeded prompts that say what to do and why; the researcher fits code work

## 0.9.0 (2026-10-23)

### Features

- **personas:** the researcher's prompt lives in server/personas, shared with its boilerplate
- **personas:** a fresh install seeds researcher, developer and critic

### Fixes

- **threads:** the agent tree's entries wrap instead of cutting off who they're with

## 0.8.0 (2026-10-23)

### Features

- **corpus:** agents load datasets into the corpus with add_dataset, with no restart
- **apps:** send a large app and its data as files, and require the turn's token on /mcp
- **apps:** an updated app moves to the newest point in the conversation

### Fixes

- **apps:** Postbox writes an app's "Sent from" line from what it sent, with the app's summary apart
- **blocks:** a block that asks again moves to the newest point in the conversation

## 0.7.0 (2026-10-23)

### Features

- **checks:** a reply that should have been a block comes back as a lint turn; a table rule
- **permissions:** writes outside Postbox wait on a card that shows the draft before anything exists

### Fixes

- **agents:** agents learn which tools are off and can ask for one on a card; ! in a thread says so
- **codex:** approval cards for MCP tool calls name the tool, in its own case, with its arguments

## 0.6.5 (2026-10-23)

### Fixes

- **threads:** side-thread sessions show in their conversation, stop with it, and can be linked
- **threads:** one session per persona per conversation; a side-thread wake forks only a busy session

## 0.6.4 (2026-10-23)

### Fixes

- **work:** a background command says it was stopped or kept, from the job's own events

## 0.6.3 (2026-10-23)

### Fixes

- **agents:** a block's answer says the person gave it, and read_message says where an item ends
- **agents:** history and read_conversation give a block's content and answer
- **agents:** history says where it cut an item, and read_message reads it in full

## 0.6.2 (2026-10-23)

### Fixes

- **stop:** never kill a background job you chose to keep running

## 0.6.1 (2026-10-23)

### Fixes

- **uat:** run.json records the effort agents ran at, and reports' Agents line is read back

## 0.6.0 (2026-10-23)

### Features

- **work:** agents in the sidebar, a Work ledger, and Work in a right pane with full screen
- **uat:** agents run on Haiku at low effort, and measurement scenarios keep the personas' models
- **uat:** test the Agents section, the Work ledger and the right pane

### Fixes

- **uat:** a stopped run stops its Postbox, and workspaces are their own git repos
- **agents:** word the quick panel's mode help with modeHelp, which replaced KIRO_PERMISSIONS

## 0.5.0 (2026-10-23)

### Features

- **checks:** run every headless check in parallel with npm run check:browser, in CI too

### Fixes

- **checks:** check-permissions waits on a time budget, and check-all says how it picks ports
- **transcript:** scrolled up, hold still the message across the middle of the view

## 0.4.0 (2026-10-23)

### Features

- **uat:** size runs by evidence, end phases on triggers, keep runs with verdicts, refit with stats

## 0.3.0 (2026-10-23)

### Features

- **rail:** show the build's version and commit under Personas
