---
name: deep-research
description: Multi-source evidence research using Smart Search, Tavily, Exa, managed browser search and last30days, with semantic planning and optional GPT Researcher synthesis.
---

# Deep Research

Run from this repository root. Read [setup](docs/SETUP.md) first and configure
external credentials using `python scripts/setup.py init`. Never print keys.
The repository is portable; do not assume the author's home paths or accounts.

1. Scope the user's research goal, constraints, language and information needs.
2. Read [semantic query planning](references/query-planning.md). Use semantic
   concepts, evidence provenance and independent information needs. Avoid sending
   the entire brief as one query. Agent mode hands decisions to the current agent.
3. Execute `python scripts/deep_research.py "<query>" -o outputs/<slug>
   --planes smart,browser,last30days --planner agent --no-gptr`.
   If exit 3, read `planner_request.json`, produce a valid decision and resume
   with `--query-plan <path>`. Use the same output directory to reuse cache.
4. Browser operations must use managed browser-mcp and stable profiles, following
   the environment's browser rules. Users handle login/CAPTCHA manually.
5. Read the evidence pack and verify material claims against primary sources.
   Source failures and budget exhaustion remain unresolved limitations.
6. Return the report location, evidence counts by plane, stop reason and gaps.
   `--no-gptr` produces an evidence memo, not a full narrative research report.
7. Feishu publishing is optional and requires an explicit user request. Read the
   publishing reference and use `scripts/publish_feishu.py` only when requested.
   IM notification is separately opt-in via `--notify`; no implicit recipient.

No search engine or model is assumed configured. Use the doctor commands to
distinguish installed/configured components from real successful requests.
