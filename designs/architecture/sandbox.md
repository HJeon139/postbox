# Sandboxed pages that load nothing

Part of [the architecture](../architecture.md).

**Decision.** An agent app or diagram page is sandboxed by its response header, `Content-Security-Policy: sandbox allow-scripts; …`, not by the iframe’s `sandbox` attribute. It is self-contained:
- **Inline:** the kit, the stylesheet and the diagram script are inlined into the page when it’s served. Before serving an app version for the first time, the server asks V8 to parse each classic inline script and caches any syntax errors with their source positions (#328). It never runs the script; only the sandboxed page does.
- **Libraries:** D3, KaTeX and Mermaid reach it as text over the postMessage bridge, and run as inline scripts. KaTeX’s fonts travel inside its stylesheet as `data:` URLs.
- **Policy:** it allows inline code, `data:` images and fonts, `blob:` audio and images from Postbox’s own `/media/`, and nothing else that loads from a URL. `/media/` sends no `Cross-Origin-Resource-Policy`, because these pages’ origin is opaque and `same-origin` or `same-site` would block every app image; what that leaves another site to learn is written beside `SAME_ORIGIN_ONLY` in [`server/review-files.mjs`](../../server/review-files.mjs) ([#992](https://github.com/HJeon139/postbox/issues/992)).
- **Framed by Postbox alone** ([#992](https://github.com/HJeon139/postbox/issues/992)): its policy ends in `frame-ancestors` naming the origin the request came to, `http://127.0.0.1:<port>` or `http://localhost:<port>`, from the `Host` header the request gate has already checked. Postbox’s page frames these pages only by relative URLs, so the page and its frames share that origin wherever it runs: a browser, the Claude desktop app’s browser pane, view_app’s capture. The two spellings are different origins, so the policy names only the one asked for, not both. It names the origin rather than `'self'`, because the page’s own origin is opaque.

**What it rests on**
- **Measured in the browser people use.** The Claude desktop app’s browser pane refuses to load any frame that has the `sandbox` attribute (`ERR_BLOCKED_BY_CLIENT`). It also blocks every request a sandboxed, opaque-origin page makes, while letting its inline scripts run. Headless Chrome allowed all of it, which is why the end-to-end runs passed while apps and diagrams stayed blank in the pane.
- **The same isolation.** The header sandbox gives the page an opaque origin, exactly as the attribute does. The host’s bridge only answers frames whose origin is `null`: if a page ever arrived without the header, it would be same-origin, and the bridge would shut it instead of serving it. A test checks that every sandbox page carries the policy.
- **Sturdier everywhere.** A page that needs no requests can’t be broken by an extension, a proxy or a slow network.

**Revisit when** apps need large assets of their own. Then serve them from a separate origin rather than relaxing the policy.
