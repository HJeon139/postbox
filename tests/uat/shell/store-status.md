# Store status line

**Where:** Across the bottom of the window, only while Postbox can’t save changes.

## Why it exists

Postbox keeps everything in its own Redis store (#508’s requirements, ST-3; design 6.6, decision 7). When that store can’t be written, Postbox refuses changes rather than keeping them somewhere that could be lost, and starts no agent turn. The line says why, in plain words, and offers Retry, so you’re never left guessing why a message didn’t send or an agent stopped.

## Expected functionality

- While the store is down, one line names the cause: another program has its port, its Redis is missing, its file is damaged, it stopped and is starting again, it refused a write, or it’s reading back what it holds. It says agents don’t start new turns until then.
- Nothing covers the page: conversations stay readable, the composer sits above the line, and a message you send is refused with a toast saying why.
- An agent working when the store went down stops; once the store is back, its reply reads “Stopped at <time>: Postbox couldn’t save changes”.
- Retry asks Postbox to start its store again, or to read it back now. The line goes once Postbox can save again, and a screen reader hears “Postbox can save changes again.”

## Steps to reproduce

1. Run Postbox on a scratch folder (`node server/index.mjs --port 4182 --data /tmp/pb-uat-store --fresh`) and open <http://127.0.0.1:4182/>.
2. Send a message to an agent, and while it replies, stop the store’s Redis: `pkill -9 -f /tmp/pb-uat-store/redis/redis.conf`. Postbox starts it again by itself; to see the line stay, move `bin/redis-server` out of its Redis folder first, and back before step 4.
3. Watch the bottom of the window, then try sending another message.
4. Press Retry if the line is still there.

**Pass if:** The line appears with its cause and Retry, the conversation stays readable, the second message is refused with a reason, the agent’s reply says the store stopped it, and the line goes once the store is back.
