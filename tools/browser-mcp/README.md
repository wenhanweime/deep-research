# Bundled managed browser service

Node.js 22+ and Chrome required. From this directory:

```sh
npm ci
npm start
```

In another terminal: `node tools/browser-mcp/cli.mjs health` (from repository root).
Set `DEEP_RESEARCH_BROWSER_BIN` to the absolute path of `tools/browser-mcp/cli.mjs`,
or add this directory to PATH with a `browser-mcp` symlink. The CLI must be executable.
The service alone invokes the bundled daemon; agents must use the HTTP facade.
Default HTTP endpoint: `http://127.0.0.1:19451/mcp`. Do not expose it publicly.
Set `CDP_BROWSER_CHROME` to the Chrome executable if auto-detection fails.
Existing browser-mcp installations can be reused; do not start a second service
on the same port. Profiles/cookies remain outside Git in the user's home.
`npm test` uses the fake daemon and does not operate a real browser.
