# Narration: a local voice in its own process

Part of [the architecture](../architecture.md).

**Decision.** Agent apps read aloud with Kokoro, through `kokoro-js`, in a child process that starts on first use and stops after five idle minutes.
- **Audio:** each clip is stored once in the blob store, under its SHA-256, and reused for the same text and voice.
- **Delivery:** the app gets the audio over the postMessage bridge and plays it from a `blob:` URL, the one media source the sandbox allows.
- **Pace:** the kit synthesizes on Play, one passage at a time, so the pre-display check makes no audio.

**What it rests on**
- **Local and free.** No audio leaves the computer, and there’s no account.
- **Isolation.** Kokoro brings native packages with open advisories (`sharp`, `onnxruntime-node`). In a child process, they never run inside the server that holds your conversations.
- **It degrades to text.** The transcript is always on screen; without the voice, the player says so and the walkthrough still reads.

**Revisit when** word-level timing matters (Kokoro gives none, so the transcript follows by passage), or a better local voice appears.
