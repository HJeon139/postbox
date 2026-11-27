# Wake-limit confirm

![Wake-limit confirm](../../screenshots/hop-confirm.png)

**Where:** After the room’s chain limit of agent-to-agent wakes in one chain: 1,000 unless the room sets another in its form in the main menu, Wake chain limit… (three until #320, ten until #492, 50 until #1035). A chain ends when you act or no agent is left working on it.

## Why it exists

Stops two agents from looping on each other.

## Expected functionality

- Says which agent wants to wake which and why; allow or decline.
- Only one waits at a time.

## Steps to reproduce

1. Run the demo (`node tools/demo.mjs --port 4180`) and open <http://127.0.0.1:4180/> while it plays; keep the tab open.
2. The demo never reaches the limit on its own: scene 7’s loop in “Index planning” ends itself after about 20 wakes, far under 1,000, and the mock @researcher it ran with then answers the next loop with “That settles it.” at once. So after the demo, make a new room with @indexer and @researcher (main menu › Rooms › +, New room); then press the gear after its title, and in the room’s form choose Wake chain limit… and set it to 3.
3. In the new room, send “@indexer check the editions with the researcher, in a loop”. The two wake each other in the conversation; after the third wake, the fourth waits on the card “Let researcher wake indexer?”.
4. Choose Let researcher wake indexer, and set the limit back afterward.

**Pass if:** The card says which agent wants to wake which, past the limit of 3, with the reason; no fourth wake happens before you allow it, and it happens once you do.
