# Image block

![Image block](../../screenshots/image-block.png)

**Where:** Agent replies with an image.

## Why it exists

Images from allowed origins only, always with alt text.

## Expected functionality

- Shows the image with its caption; alt text required; images from disallowed origins are rejected and the fallback is shown.

## Steps to reproduce

1. Run the demo (`node tools/demo.mjs --port 4180`) and open <http://127.0.0.1:4180/> while it plays; keep the tab open.
2. In “Catalog tour”, check the image and its alt text.

**Pass if:** The image renders with alt text.
