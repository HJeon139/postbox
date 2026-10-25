# Diagnosis: tracing a failure to a different CLI environment

- persona: A developer troubleshooting a command that fails only with project settings. Careful with credentials, asks for evidence before changing a working setup, and writes short messages.
- agents: researcher
- project: CLI setup diagnosis
- conversation: Why project mode fails

Work with @researcher on a local, fake CLI failure. Use only fixture files with made-up values: no real credentials, network requests or changes to the machine’s setup. The project-settings variant reports an expired token; the user-settings variant succeeds. A separate profile check also reports an expired token, but it does not run the failing command or use its settings. See whether @researcher can trace the failure without asking you to refresh working credentials.

## Phase 1: Reproduce the failure safely

Ask @researcher to create a tiny Node.js CLI fixture and fake user/project settings files. Keep all values made up, with no real credentials or network calls. Its project-settings command should fail with `SessionTokenExpired`; its user-settings command should succeed. Add a separate profile-check script that prints the same generic expired-token error, without calling a real service. Ask @researcher to run `node probe.mjs --settings project` and `node unrelated-profile-check.mjs`, then explain what the evidence establishes and what it does not.

## Phase 2: Compare the working command

Tell @researcher that `node probe.mjs --settings user` succeeds and ask whether you should refresh your credentials. Expect it to compare the exact failing command with the working command, which differs by one setting, identify that difference as the demonstrated cause in this fixture, and avoid presenting the unrelated profile check as proof about the CLI. It should distinguish verified facts from guesses and not ask you to change real credentials.
