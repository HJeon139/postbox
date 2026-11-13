# Attach an image: an agent says what a picture you attached shows

- persona: A designer who sends agents pictures and expects them to look. Writes short messages.
- agents: researcher
- permission_modes: researcher=auto
- project: Picture check
- conversation: What’s in the picture

A targeted scenario for #1307, Claude Code only, with @researcher on this computer in Auto. A Claude Code agent said it couldn’t see an image the person attached. The test picture, `picture.png` in `tests/uat/e2e/attachments/`, is a small PNG made for this run; its name says nothing of what it shows, so only an agent that opened the image can say. Watch for an agent that says it can’t read or see the file, reads it as text or binary, asks for permission to read it, or guesses.

`node tools/uat-run.mjs --scenario attachimage --budget 2 --max-cost 5 --file no`

## Phase 1: One picture, described

- triggers: attached-image-read
- steps: 3

Attach `picture.png` with `attach_file` and ask @researcher, in one message, what the picture shows: its shape, its color and any word in it. Don’t say what’s in it yourself. Then say whether @researcher’s reply names what the picture really shows, whether it said it couldn’t open or see the file, and whether a permission card about reading it appeared.

## Phase 2: The picture again, in a later message

- triggers: attached-image-read-again
- steps: 3

Attach `picture.png` again with `attach_file`, in a new message, and ask @researcher where in the picture the word sits. A later message’s file is a new upload, so the agent has to open it again. Say whether its reply names what the picture shows, and whether it said it couldn’t open the file this time.
