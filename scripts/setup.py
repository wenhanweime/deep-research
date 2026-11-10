#!/usr/bin/env python3
"""First-run setup and explicit online verification. Never prints credential values."""
from __future__ import annotations
import argparse
import getpass
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from runtime_config import ROOT, config_dir, env_file, load_config, read_env

GROUPS = {
    "smart": ("Smart Search (Node 18+; npm install -g @konbakuyomu/smart-search@0.1.13)",
              ["XAI_API_KEY", "XAI_MODEL", "OPENAI_COMPATIBLE_API_URL", "OPENAI_COMPATIBLE_API_KEY", "OPENAI_COMPATIBLE_MODEL"]),
    "tavily": ("Tavily structured search", ["TAVILY_API_KEY"]),
    "exa": ("Exa structured search", ["EXA_API_KEY"]),
    "planner": ("Standalone semantic planner; agent mode requires no key", ["DEEP_RESEARCH_PLANNER_API_KEY", "DEEP_RESEARCH_PLANNER_MODEL", "DEEP_RESEARCH_PLANNER_BASE_URL"]),
    "last30days": ("Recent/social search; install last30days and follow docs/SETUP.md", ["DEEP_RESEARCH_LAST30_SCRIPT", "SCRAPECREATORS_API_KEY", "APIFY_API_TOKEN", "BSKY_HANDLE", "BSKY_APP_PASSWORD", "TRUTHSOCIAL_TOKEN", "OPENAI_API_KEY", "XAI_API_KEY", "OPENROUTER_API_KEY", "PARALLEL_API_KEY", "BRAVE_API_KEY"]),
    "gptr": ("Optional GPT Researcher; pip install -r requirements-gptr.txt", ["OPENAI_API_KEY", "FAST_LLM", "SMART_LLM"]),
    "browser": ("Browser search: bundled tools/browser-mcp + Chrome; see docs/SETUP.md", ["DEEP_RESEARCH_BROWSER_BIN"]),
    "feishu": ("Optional Feishu: authenticated lark-cli; publish is a separate command", ["FEISHU_RESEARCH_NOTIFY_USER_ID"]),
}

def secret(key):
    return any(x in key for x in ("KEY", "TOKEN", "PASSWORD"))

def init(non_interactive=False):
    directory, target = config_dir(), env_file()
    # Fail closed if the selected secret location could be committed in this repo.
    if target.is_relative_to(ROOT):
        raise ValueError("Choose a configuration location outside the repository")
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if not target.exists():
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write((ROOT / "config/.env.example").read_text())
    else:
        target.chmod(0o600)
    print(f"Configuration: {target} (0600); existing values are preserved")
    if non_interactive:
        print("Fill enabled tools in that file, then run: python3 scripts/setup.py doctor")
        return 0
    text = target.read_text()
    values = read_env(target)
    for group, (description, keys) in GROUPS.items():
        print(f"\n[{group}] {description}")
        if input("Configure this tool? [y/N] ").strip().lower() != "y":
            continue
        for key in keys:
            marker = " (already set; Enter keeps it)" if values.get(key) else " (Enter skips)"
            value = getpass.getpass(key + marker + ": ") if secret(key) else input(key + marker + ": ")
            if not value:
                continue
            if any(c in value for c in ("\n", "\r", "\x00")):
                raise ValueError("Configuration values must be single-line")
            # No interpolation or executable shell syntax is ever evaluated.
            lines = text.splitlines()
            replacement = key + "=" + value
            lines = [replacement if line.startswith(key + "=") else line for line in lines]
            if not any(line.startswith(key + "=") for line in lines):
                lines.append(replacement)
            text = "\n".join(lines) + "\n"
            values[key] = value
        # Atomic replacement, mode 0600, including interrupted setup sessions.
        fd, temporary = tempfile.mkstemp(dir=target.parent, prefix=".setup-")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                stream.write(text)
            os.replace(temporary, target)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
    print("\nSaved. Run doctor, then doctor --online for real provider requests (may incur charges).")
    return 0

def command_ok(args, timeout=45):
    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
        return result.returncode == 0, result.stdout
    except (OSError, subprocess.TimeoutExpired):
        return False, ""

def doctor(online=False, selected=None):
    load_config()
    import multi_source_search as search
    from query_planner import load_config as planner_config
    chosen = set(selected.split(",")) if selected else set(GROUPS)
    unknown = chosen - GROUPS.keys()
    if unknown:
        raise ValueError("Unknown tools: " + ", ".join(sorted(unknown)))
    configured = lambda key: bool(os.environ.get(key, "").strip())
    smart_ready = bool(search.SMART_SEARCH) and (configured("XAI_API_KEY") and configured("XAI_MODEL") or all(configured(k) for k in ("OPENAI_COMPATIBLE_API_URL", "OPENAI_COMPATIBLE_API_KEY", "OPENAI_COMPATIBLE_MODEL")))
    planner = planner_config()
    checks = {
        "smart": bool(smart_ready),
        "tavily": configured("TAVILY_API_KEY"),
        "exa": configured("EXA_API_KEY"),
        "planner": bool(planner["key"] and planner["model"]),
        "last30days": search.LAST30_PY.is_file(),
        "gptr": importlib.util.find_spec("gpt_researcher") is not None and configured("OPENAI_API_KEY"),
        "browser": bool(shutil.which(os.environ.get("DEEP_RESEARCH_BROWSER_BIN") or "browser-mcp")),
        "feishu": bool(shutil.which("lark-cli")),
    }
    failures = 0
    for name in GROUPS:
        if name not in chosen:
            continue
        ready = checks[name]
        status = "CONFIGURED (not verified)" if ready else "MISSING prerequisites; see docs/SETUP.md#" + name
        if online and ready:
            try:
                if name in ("tavily", "exa"):
                    import urllib.request
                    key = os.environ[name.upper() + "_API_KEY"]
                    body = {"query": "Python documentation", "max_results": 1} if name == "tavily" else {"query": "Python documentation", "numResults": 1}
                    headers = {"Content-Type": "application/json"}
                    if name == "tavily":
                        headers["Authorization"] = "Bearer " + key
                    else:
                        headers["x-api-key"] = key
                    url = "https://api.tavily.com/search" if name == "tavily" else "https://api.exa.ai/search"
                    with urllib.request.urlopen(urllib.request.Request(url, data=json.dumps(body).encode(), headers=headers), timeout=30) as response:
                        data = json.load(response)
                    ready = bool(data.get("results"))
                elif name == "smart":
                    ready, output = command_ok([search.SMART_SEARCH, "search", "--format", "json", "Python documentation"], 100)
                    ready = ready and bool(search.normalize_smart_json(output, "doctor"))
                elif name == "browser":
                    # Check service health only; login and each site need manual smoke tests.
                    ready, _ = command_ok([os.environ.get("DEEP_RESEARCH_BROWSER_BIN") or "browser-mcp", "health"])
                    status = "SERVICE HEALTHY (site login/CAPTCHA unverified)" if ready else "FAILED service health"
                elif name == "last30days":
                    with tempfile.TemporaryDirectory() as tmp:
                        ready = bool(search.last30days_plane("Python", Path(tmp), depth="quick"))
                elif name == "planner":
                    import urllib.request
                    req = urllib.request.Request(planner["base"].rstrip("/") + "/chat/completions", data=json.dumps({"model": planner["model"], "messages": [{"role": "user", "content": "Reply OK"}]}).encode(), headers={"Authorization": "Bearer " + planner["key"], "Content-Type": "application/json"})
                    with urllib.request.urlopen(req, timeout=45) as response:
                        ready = bool(json.load(response).get("choices"))
                elif name == "feishu":
                    ready, output = command_ok(["lark-cli", "auth", "status", "--json"])
                    ready = ready and bool((json.loads(output).get("identities") or {}).get("user"))
                    status = "AUTH FOUND (write scopes unverified)" if ready else "FAILED authentication"
                elif name == "gptr":
                    status = "INSTALLED (synthesis not run; use a research smoke test)"
                if name not in ("browser", "feishu", "gptr"):
                    status = "VERIFIED results received" if ready else "FAILED or zero results"
            except Exception as exc:
                ready, status = False, "FAILED (" + type(exc).__name__ + "); check credentials/network/quota"
        if not ready:
            failures += 1
        print(f"{name}: {status}")
    if not online:
        print("Static checks only. --online sends real requests; --tools selects required tools.")
    return 1 if failures else 0

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    init_parser = sub.add_parser("init")
    init_parser.add_argument("--non-interactive", action="store_true")
    check = sub.add_parser("doctor")
    check.add_argument("--online", action="store_true")
    check.add_argument("--tools", help=",".join(GROUPS))
    args = parser.parse_args()
    try:
        return init(args.non_interactive) if args.command == "init" else doctor(args.online, args.tools)
    except (ValueError, OSError) as exc:
        print(type(exc).__name__ + ": configuration operation failed; check path and file format", file=sys.stderr)
        return 2

if __name__ == "__main__":
    raise SystemExit(main())
