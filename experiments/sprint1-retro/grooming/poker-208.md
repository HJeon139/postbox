# Estimate #208 (one item), 27 October 2026

Same scale and references as poker-round2.md. #208's two open choices are now decided (see its latest comment): "Uses your setup" personas get their own memory too, and a persona's memory is deleted with it after the Undo window.

Item `#208`: per-persona memory on every backend, as in the spec comment on #208 plus the decision comment: Claude Code and Agent SDK via autoMemoryDirectory in the --settings overlay, a folder per persona and project in Postbox's data folder; Codex memories off per turn; Kiro own KIRO_HOME per Isolated persona, memory.mode off (or shown shared) with the person's setup; persona sheet memory line; delete with the persona after Undo; remote hosts the same. Two checks before building: Codex `-c memories…=false` per run, Kiro memories following KIRO_HOME.

Write `.scratch/grooming/estimate208-<your handle>.json` as [{ "item": "#208", "card": ..., "driver": "one line" }]. If it reads bigger than the 13 reference, card "split" and say where to cut. Don't open the others' files; post only "done" with an @-mention of researcher.
