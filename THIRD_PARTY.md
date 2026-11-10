# Dependencies and provenance

Deep Research orchestration and the bundled browser-mcp/daemon source were
extracted from the maintainer's local project. Personal state, configuration,
research output and previous Git history were excluded.

External components are installed separately and retain their own licenses:

- Smart Search CLI: https://github.com/konbakuyomu/smartsearch (MIT; CLI version 0.1.13 tested for interface compatibility).
- last30days: https://github.com/mvanhorn/last30days-skill (see its LICENSE; not redistributed here).
- GPT Researcher: https://github.com/assafelovic/gpt-researcher (see its LICENSE; optional Python dependency).
- yt-dlp: https://github.com/yt-dlp/yt-dlp (see its license; optional YouTube dependency).
- Browser service npm dependencies: see `tools/browser-mcp/package-lock.json` and installed package license files.

Search APIs, social platforms, model APIs, Chrome and Feishu require the user's
own service access and are subject to their providers' terms. API access and
public content availability are independent of the source-code license.
