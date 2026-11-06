# Review figures: a draft with two images from the agent’s folder, here and on a host

- persona: An analyst who writes short weekly notes with a chart or two, and approves them before they go to the team. Wants to see the figures in the draft itself, not a link to a file. Writes short messages.
- agents: researcher, critic
- place: researcher=local, critic=host1
- project: Weekly note
- conversation: Figures in a draft

A targeted scenario for #780, with one host (`--host`, once), Claude Code only: @researcher runs on this computer and @critic on host1. A review block can carry images from its agent’s folder (`files` on the block), and its Markdown names each by its name or its path, so Preview draws them. Each phase has one agent make two small PNG figures in its folder with a short script, using nothing over the network and no packages to install, then put a short draft up for review with both figures in it. Don’t name the block’s fields for it: whether the agent finds how to attach them from the tool’s description is part of what this checks. Watch for a figure that shows as “This image couldn’t load”, one that’s missing or blank, an agent that links the files or shows them in a separate image block instead, and an agent on the host that says it can’t attach a file from there.

`node tools/uat-run.mjs --scenario reviewfigures --host <host1> --host-setting host1.idleTimeout=1min --file no`. Phase 1 alone runs without a host: `--phases 1`.

## Phase 1: Two figures in a draft, here

- triggers: review-figures-shown
- steps: 6

Ask @researcher to write a short script in its folder that makes two small PNG images, `figs/today.png` and `figs/trend.png`, each a few hundred pixels wide in a different plain color, to run it, and then to put a draft weekly note of about eight lines up for you to approve, with both images shown in the draft itself. Open the review’s Preview and check that both figures show, each where the draft puts it, and that neither shows as an image that couldn’t load. Say what you saw, then approve the draft.

## Phase 2: The same, from an agent on a host

- triggers: host-review-figures-shown
- steps: 6

Ask @critic, on host1, to do the same in its folder there: a short script that makes two small PNG images, `figs/today.png` and `figs/trend.png`, in two other colors, then a draft of about eight lines up for you to approve, with both images shown in the draft. Open its Preview and check that both figures show, in @critic’s colors and not @researcher’s, and that neither shows as an image that couldn’t load. Say what you saw, then approve the draft.
