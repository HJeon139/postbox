# Changelog

Every release of Postbox, newest first. Written by `npm run release` from the commits since the last one.

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
