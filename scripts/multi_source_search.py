#!/usr/bin/env python3
"""
Fuse four search planes into one evidence pack:

1) Smart Search CLI  (API / multi-provider: OpenAI-compat search, Exa, Tavily-backed, …)
2) Direct API keys   (Tavily / Exa env if present — via smart-search or urllib fallback)
3) Chrome CDP daemon (Google / Reddit / X SERP) for login-aware / JS-heavy results
4) last30days       (Reddit / X / YouTube / TikTok / Instagram / HN / prediction markets)

Output layout:
  <out>/
    manifest.json
    smart_search.json
    browser_serp.json
    last30days.json
    sources.jsonl          # normalized {url,title,snippet,source,plane}
    summary.md
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote_plus

from breadth import (
    coverage_metrics,
    profile_families,
    annotate_items,
    normalize_width,
    sites_for_dimension,
)
from progressive import attach_mined_entities, run_progressive
from query_planner import SemanticPlanner
from semantic import run_semantic

from runtime_config import config_dir, env_file, load_config

ROOT = Path(__file__).resolve().parent
SMART_SEARCH = os.environ.get("DEEP_RESEARCH_SMART_SEARCH_BIN") or shutil.which("smart-search") or ""
GPTR_ENV = env_file()
BROWSER_PY = ROOT / "browser_search.py"
LAST30_PY = Path(os.environ.get("DEEP_RESEARCH_LAST30_SCRIPT", str(ROOT.parent / "vendor/last30days/scripts/last30days.py"))).expanduser()


def load_dotenv_file(path: Path) -> None:
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def run_cmd(cmd: list[str], timeout: int = 120, cwd: Path | None = None) -> tuple[int, str, str]:
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, cwd=cwd)
        return p.returncode, p.stdout or "", p.stderr or ""
    except subprocess.TimeoutExpired:
        return 124, "", "timeout"
    except Exception as e:
        return 1, "", str(e)


def smart_search_plane(query: str, out_dir: Path) -> list[dict]:
    """Plane A: smart-search CLI (primary API search router)."""
    results: list[dict] = []
    if SMART_SEARCH:
        jobs = [
            ("search", [SMART_SEARCH, "search", "--format", "json", query]),
            ("exa", [SMART_SEARCH, "exa-search", "--format", "json", query]),
        ]
        for name, cmd in jobs:
            code, out, err = run_cmd(cmd, timeout=90)
            path = out_dir / f"smart_{name}.json"
            path.write_text(out if out.strip() else json.dumps({"error": err, "code": code}), encoding="utf-8")
            if code != 0 or not out.strip():
                print(f"[smart-search:{name}] fail code={code}", file=sys.stderr)
                continue
            items = normalize_smart_json(out, plane=f"smart-search:{name}")
            results.extend(items)
    else:
        print("[smart-search] binary missing; direct APIs still available", file=sys.stderr)

    # Exa also works without the Smart Search executable.
    if not SMART_SEARCH and os.environ.get("EXA_API_KEY"):
        try:
            import urllib.request
            req = urllib.request.Request("https://api.exa.ai/search",
                data=json.dumps({"query": query, "numResults": 8}).encode(),
                headers={"x-api-key": os.environ["EXA_API_KEY"], "Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=45) as response:
                data = json.load(response)
            (out_dir / "exa_direct.json").write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
            results.extend(normalize_smart_json(json.dumps(data), "api:exa"))
        except Exception as exc:
            print(f"[exa] failed: {type(exc).__name__}", file=sys.stderr)

    # optional: tavily via official API if key present (smart-search may already cover it)
    tavily_key = os.environ.get("TAVILY_API_KEY")
    if tavily_key:
        try:
            import urllib.request

            body = json.dumps(
                {
                    "api_key": tavily_key,
                    "query": query,
                    "max_results": 8,
                    "include_answer": False,
                }
            ).encode()
            req = urllib.request.Request(
                "https://api.tavily.com/search",
                data=body,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=45) as resp:
                data = json.load(resp)
            (out_dir / "tavily_direct.json").write_text(
                json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            for r in data.get("results") or []:
                results.append(
                    {
                        "url": r.get("url") or "",
                        "title": r.get("title") or "",
                        "snippet": (r.get("content") or "")[:800],
                        "source": "tavily",
                        "plane": "api:tavily",
                    }
                )
            print(f"[tavily] {len(data.get('results') or [])} hits", file=sys.stderr)
        except Exception as e:
            print(f"[tavily] fail {e}", file=sys.stderr)

    (out_dir / "smart_search.json").write_text(
        json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return results


def normalize_smart_json(raw: str, plane: str) -> list[dict]:
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        items = []
        for line in raw.splitlines():
            if "http" in line:
                url = "http" + line.split("http", 1)[1].split()[0].rstrip(".,)")
                items.append(
                    {
                        "url": url,
                        "title": line[:160],
                        "snippet": line,
                        "source": plane,
                        "plane": plane,
                    }
                )
        return items

    rows = []
    if isinstance(data, list):
        rows = data
    elif isinstance(data, dict):
        for k in ("results", "sources", "data", "items", "organic"):
            if isinstance(data.get(k), list):
                rows = data[k]
                break
        if not rows and data.get("content"):
            rows = [data]

    out = []
    for it in rows:
        if not isinstance(it, dict):
            continue
        url = it.get("url") or it.get("link") or it.get("href") or ""
        title = it.get("title") or ""
        snippet = (
            it.get("snippet")
            or it.get("content")
            or it.get("body")
            or it.get("text")
            or it.get("raw_content")
            or ""
        )
        if url or title:
            out.append(
                {
                    "url": url,
                    "title": str(title)[:240],
                    "snippet": str(snippet)[:800],
                    "source": it.get("source") or plane,
                    "plane": plane,
                }
            )
    return out


def browser_plane(
    query: str,
    out_dir: Path,
    sites: str,
    lane: str,
    headless: bool,
    max_results: int = 30,
    pages: int = 1,
) -> list[dict]:
    """Plane B: Chrome CDP Google / Reddit / X."""
    out_path = out_dir / "browser_serp.json"
    cmd = [
        sys.executable,
        str(BROWSER_PY),
        query,
        "--sites",
        sites,
        "--lane",
        lane,
        "--max-results-per-site",
        str(max_results),
        "--pages",
        str(pages),
        "-o",
        str(out_path),
    ]
    if headless:
        cmd.append("--headless")
    code, out, err = run_cmd(cmd, timeout=300)
    if err:
        print(err, file=sys.stderr)
    if code != 0 or not out_path.is_file():
        print(f"[browser] fail code={code}", file=sys.stderr)
        return []
    try:
        items = json.loads(out_path.read_text(encoding="utf-8"))
    except Exception:
        return []
    norm = []
    for it in items:
        if not isinstance(it, dict):
            continue
        norm.append(
            {
                "url": it.get("url") or "",
                "title": (it.get("title") or "")[:240],
                "snippet": (it.get("snippet") or "")[:800],
                "source": it.get("source") or "browser",
                "plane": f"browser:{it.get('source') or 'serp'}",
            }
        )
    print(f"[browser] {len(norm)} hits", file=sys.stderr)
    return norm


def last30days_plane(
    query: str,
    out_dir: Path,
    days: int = 30,
    depth: str = "quick",
) -> list[dict]:
    """Plane C: recent community and social signals from last30days."""
    raw_path = out_dir / "last30days.json"
    status_path = out_dir / "last30days_status.json"
    if not LAST30_PY.is_file():
        status_path.write_text(
            json.dumps({"status": "missing", "path": str(LAST30_PY)}, indent=2),
            encoding="utf-8",
        )
        print(f"[last30days] script missing: {LAST30_PY}", file=sys.stderr)
        return []

    cmd = [
        sys.executable,
        str(LAST30_PY),
        query,
        "--emit=json",
        "--no-native-web",
        f"--days={days}",
    ]
    if depth == "quick":
        cmd.append("--quick")
        timeout = 120
    elif depth == "deep":
        cmd.append("--deep")
        timeout = 360
    else:
        timeout = 240

    isolated_cwd = config_dir() / "last30days"
    isolated_cwd.mkdir(parents=True, exist_ok=True, mode=0o700)
    code, out, err = run_cmd(cmd, timeout=timeout, cwd=isolated_cwd)
    if err:
        (out_dir / "last30days_stderr.log").write_text(err, encoding="utf-8")
    if code != 0 or not out.strip():
        status_path.write_text(
            json.dumps(
                {"status": "failed", "code": code, "error": err[:1000]},
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
        print(f"[last30days] fail code={code} {err[:200]}", file=sys.stderr)
        return []

    try:
        data = json.loads(out)
    except json.JSONDecodeError as e:
        raw_path.write_text(out, encoding="utf-8")
        status_path.write_text(
            json.dumps({"status": "invalid_json", "error": str(e)}, indent=2),
            encoding="utf-8",
        )
        print(f"[last30days] invalid JSON: {e}", file=sys.stderr)
        return []

    raw_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    norm = normalize_last30days(data)
    source_counts = {
        name: len(data.get(name) or [])
        for name in (
            "reddit",
            "x",
            "youtube",
            "tiktok",
            "instagram",
            "hackernews",
            "bluesky",
            "truthsocial",
            "polymarket",
        )
    }
    errors = {
        key: value
        for key, value in data.items()
        if key.endswith("_error") and value
    }
    status_path.write_text(
        json.dumps(
            {
                "status": "ok",
                "days": days,
                "depth": depth,
                "normalized_hits": len(norm),
                "counts": source_counts,
                "errors": errors,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"[last30days] {len(norm)} hits {source_counts}", file=sys.stderr)
    return norm


def normalize_last30days(data: dict) -> list[dict]:
    """Normalize last30days' structured report into the fused source schema."""
    out: list[dict] = []

    def add(source: str, item: dict, *, title: str, url: str, snippet: str) -> None:
        if not url:
            return
        engagement = item.get("engagement") or {}
        why = item.get("why_relevant") or ""
        parts = [p for p in (snippet, why) if p]
        if engagement:
            parts.append("Engagement: " + json.dumps(engagement, ensure_ascii=False))
        out.append(
            {
                "url": url,
                "title": (title or url)[:240],
                "snippet": "\n".join(parts)[:1200],
                "source": source,
                "plane": f"last30days:{source}",
                "published_at": item.get("date") or "",
                "engagement": engagement,
            }
        )

    for it in data.get("reddit") or []:
        add("reddit", it, title=it.get("title") or "", url=it.get("url") or "", snippet="")
    for it in data.get("x") or []:
        text = it.get("text") or ""
        add("x", it, title=text[:160], url=it.get("url") or "", snippet=text)
    for it in data.get("youtube") or []:
        highlights = "\n".join(it.get("transcript_highlights") or [])
        add(
            "youtube",
            it,
            title=it.get("title") or "",
            url=it.get("url") or "",
            snippet=highlights or it.get("transcript_snippet") or "",
        )
    for source in ("tiktok", "instagram"):
        for it in data.get(source) or []:
            text = it.get("caption_snippet") or it.get("text") or ""
            add(source, it, title=text[:160], url=it.get("url") or "", snippet=text)
    for it in data.get("hackernews") or []:
        add(
            "hackernews",
            it,
            title=it.get("title") or "",
            url=it.get("hn_url") or it.get("url") or "",
            snippet="\n".join(it.get("comment_insights") or []),
        )
    for source in ("bluesky", "truthsocial"):
        for it in data.get(source) or []:
            text = it.get("text") or ""
            add(source, it, title=text[:160], url=it.get("url") or "", snippet=text)
    for it in data.get("polymarket") or []:
        outcomes = it.get("outcome_prices") or []
        snippet = json.dumps(outcomes, ensure_ascii=False)
        if it.get("price_movement"):
            snippet += f"\nMovement: {it['price_movement']}"
        add(
            "polymarket",
            it,
            title=it.get("question") or it.get("title") or "",
            url=it.get("url") or "",
            snippet=snippet,
        )
    return out


def dedupe(items: list[dict]) -> list[dict]:
    by_url: dict[str, dict] = {}
    order: list[str] = []
    for it in items:
        url = (it.get("url") or "").split("#")[0].rstrip("/")
        if not url:
            continue
        plane = it.get("plane") or "?"
        if url not in by_url:
            row = dict(it)
            row["planes"] = [plane]
            row["family_ids"] = list(dict.fromkeys(row.get("family_ids") or ([row.get("family_id")] if row.get("family_id") else [])))
            by_url[url] = row
            order.append(url)
            continue
        row = by_url[url]
        planes = row.setdefault("planes", [row.get("plane") or "?"])
        if plane not in planes:
            planes.append(plane)
        family_ids = row.setdefault("family_ids", [])
        for family_id in it.get("family_ids") or ([it.get("family_id")] if it.get("family_id") else []):
            if family_id and family_id not in family_ids:
                family_ids.append(family_id)
        for field in ("topics", "entities", "perspectives"):
            values = row.setdefault(field, [])
            incoming = it.get(field) or []
            if isinstance(incoming, str):
                incoming = [incoming]
            for value in incoming:
                if value and value not in values:
                    values.append(value)
        if len(it.get("snippet") or "") > len(row.get("snippet") or ""):
            row["snippet"] = it.get("snippet") or ""
        if not row.get("engagement") and it.get("engagement"):
            row["engagement"] = it.get("engagement")
        if not row.get("published_at") and it.get("published_at"):
            row["published_at"] = it.get("published_at")
    return [by_url[url] for url in order]


def write_summary(path: Path, query: str, items: list[dict], metrics: dict | None = None, profile: dict | None = None, progressive: dict | None = None) -> None:
    by_plane: dict[str, int] = {}
    for it in items:
        for plane in it.get("planes") or [it.get("plane") or "?"]:
            by_plane[plane] = by_plane.get(plane, 0) + 1
    lines = [
        f"# Multi-source search: {query}",
        "",
        f"- time: {datetime.now(timezone.utc).isoformat()}",
        f"- total unique URLs: {len(items)}",
        "",
        "## By plane",
        "",
    ]
    for k, v in sorted(by_plane.items(), key=lambda x: -x[1]):
        lines.append(f"- **{k}**: {v}")
    if progressive:
        lines += ["", "## Progressive rounds", ""]
        lines.append(f"- stop reason: **{progressive.get('stop_reason')}**")
        lines.append(f"- queries used: {progressive.get('queries_used')}")
        for record in progressive.get("rounds") or []:
            lines.append(
                f"- **round {record['round_index']}**: {record['query_count']} queries → "
                f"{record['hits']} hits, {record['new_urls']} new URLs"
            )
            for query_text in record.get("queries") or []:
                lines.append(f"    - `{query_text}`")
            if record.get("mined_terms"):
                lines.append(f"    - mined → {', '.join(record['mined_terms'])}")
        mined = progressive.get("mined_terms") or []
        if mined:
            lines += ["", "### Terms discovered in the corpus", ""]
            for row in mined[:20]:
                lines.append(
                    f"- **{row['term']}** (in {row['doc_freq']} docs) — {row.get('sample_url', '')}"
                )
    if profile or metrics:
        lines += ["", "## Breadth profile", ""]
        if profile:
            lines.append(f"- width profile: **{profile.get('mode')}**")
            lines.append(f"- depth profile: **{profile.get('depth', {}).get('profile')}**")
            lines.append(f"- selected query families: {profile.get('width', {}).get('selected_queries')}")
        if metrics:
            lines.append(
                f"- family coverage: {metrics.get('family_coverage', 0):.1%}; "
                f"aspect coverage: {metrics.get('aspect_coverage', 0):.1%}; "
                f"path diversity: {metrics.get('path_diversity', 0):.1%}"
            )
            lines.append(
                f"- entities: {metrics.get('entity_count', 0)} "
                f"({metrics.get('novel_entity_count', 0)} novel); "
                f"perspectives: {metrics.get('perspective_count', 0)}; "
                f"source types: {metrics.get('source_type_count', 0)}"
            )
    lines += ["", "## Top sources", ""]
    for i, it in enumerate(items[:25], 1):
        lines.append(
            f"{i}. [{it.get('title') or it.get('url')}]({it.get('url')}) "
            f"— `{', '.join(it.get('planes') or [it.get('plane') or '?'])}`"
        )
        if it.get("snippet"):
            lines.append(f"   > {it['snippet'][:240].replace(chr(10), ' ')}")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def run_query_family(
    family: dict,
    out_dir: Path,
    planes: set[str],
    sites: str,
    lane: str,
    headless: bool,
    last30_days: int,
    last30_depth: str,
    shared_root: bool = False,
    max_results: int = 30,
    pages: int = 1,
) -> tuple[list[dict], dict]:
    """Run one independent query path and return annotated evidence."""
    family_id = family["family_id"]
    family_dir = out_dir if shared_root else out_dir / "families" / family_id
    family_dir.mkdir(parents=True, exist_ok=True)
    # The taxonomy now steers WHERE we look instead of padding the query text.
    family_sites = ",".join(family["sites"]) if "sites" in family else sites_for_dimension(family.get("dimension", ""), sites)
    planes = planes & set(family.get("planes", planes))
    raw: list[dict] = []
    errors: list[str] = []
    if "smart" in planes or "api" in planes:
        try:
            raw.extend(smart_search_plane(family["query"], family_dir))
        except Exception as exc:
            errors.append(f"smart: {exc}")
    if "browser" in planes:
        try:
            raw.extend(
                browser_plane(
                    family["query"],
                    family_dir,
                    family_sites,
                    lane,
                    headless,
                    max_results=max_results,
                    pages=pages,
                )
            )
        except Exception as exc:
            errors.append(f"browser: {exc}")
    if "last30days" in planes or "recent" in planes:
        try:
            raw.extend(last30days_plane(family["query"], family_dir, last30_days, last30_depth))
        except Exception as exc:
            errors.append(f"last30days: {exc}")
    plane_hits: dict[str, int] = {}
    for item in raw:
        plane_name = str(item.get("plane") or item.get("source") or "unknown").split(":", 1)[0]
        if plane_name.startswith("smart") or plane_name.startswith("api"):
            plane = "smart"
        elif plane_name.startswith("browser"):
            plane = "browser"
        elif plane_name.startswith("last30days"):
            plane = "last30days"
        else:
            plane = plane_name
        plane_hits[plane] = plane_hits.get(plane, 0) + 1
    health: dict[str, dict] = {}
    if "smart" in planes or "api" in planes:
        health["smart"] = {
            "status": "ok" if plane_hits.get("smart", 0) else "empty_or_failed",
            "hits": plane_hits.get("smart", 0),
        }
    if "browser" in planes:
        browser_file = family_dir / "browser_serp.json"
        health["browser"] = {
            "status": "ok" if browser_file.is_file() and plane_hits.get("browser", 0) else "empty_or_failed",
            "hits": plane_hits.get("browser", 0),
        }
    if "last30days" in planes or "recent" in planes:
        status_file = family_dir / "last30days_status.json"
        try:
            status = json.loads(status_file.read_text(encoding="utf-8")) if status_file.is_file() else {"status": "missing"}
        except Exception:
            status = {"status": "invalid"}
        health["last30days"] = {
            "status": status.get("status", "unknown"),
            "hits": plane_hits.get("last30days", 0),
            "errors": status.get("errors") or status.get("error"),
        }
    return annotate_items(raw, family), {
        "family_id": family_id,
        "query": family["query"],
        "dimension": family.get("dimension"),
        "sites": family_sites,
        "out": str(family_dir),
        "hits": len(raw),
        "plane_hits": plane_hits,
        "source_health": health,
        "errors": errors,
    }


def main() -> int:
    load_dotenv_file(GPTR_ENV)
    ap = argparse.ArgumentParser(description="Fused multi-source search")
    ap.add_argument("query")
    ap.add_argument(
        "--out",
        "-o",
        default="",
        help="evidence output directory",
    )
    ap.add_argument(
        "--planes",
        default="smart,browser,last30days",
        help="comma: smart,browser,last30days (api is included in smart)",
    )
    ap.add_argument(
        "--browser-sites",
        default="google,reddit,x,sogou-weixin",
        help="browser SERP sites: google,reddit,x,sogou-weixin",
    )
    ap.add_argument("--lane", default="cdp-browser-daemon")
    ap.add_argument("--headless", action="store_true")
    ap.add_argument("--last30-days", type=int, default=30, choices=range(1, 31))
    ap.add_argument(
        "--last30-depth",
        choices=["quick", "standard", "deep"],
        default="quick",
        help="recency-plane depth; quick is the default to cap latency/cost",
    )
    ap.add_argument(
        "--width",
        "--breadth",
        default="standard",
        choices=["legacy", "narrow", "standard", "wide", "deep-wide"],
        help="independent query-path width; legacy preserves the previous single-query behavior",
    )
    ap.add_argument(
        "--depth",
        default="standard",
        choices=["fast", "standard", "deep"],
        help="research branch depth, recorded independently from width",
    )
    ap.add_argument(
        "--max-query-families",
        type=int,
        default=None,
        help="cap selected query families after diversity selection",
    )
    ap.add_argument(
        "--rounds",
        type=int,
        default=3,
        help="search/review iterations; at least 2 for resolve then discover",
    )
    ap.add_argument(
        "--expansions-per-round",
        type=int,
        default=4,
        help="max mined-term queries to launch per follow-up round",
    )
    ap.add_argument(
        "--max-results-per-site",
        type=int,
        default=30,
        help="browser results kept per site; reading wide is what makes term mining work",
    )
    ap.add_argument(
        "--pages",
        type=int,
        default=1,
        help="SERP pages to walk where supported (google, sogou-weixin)",
    )
    ap.add_argument(
        "--max-docs",
        type=int,
        default=80,
        help="documents written into gptr-docs/sources.md",
    )
    ap.add_argument("--no-parallel", action="store_true")
    ap.add_argument("--planner", choices=["auto", "agent", "legacy"], default="agent",
                    help="semantic API planner, agent-supplied decisions, or explicit old deterministic planner")
    ap.add_argument("--query-plan", default="", help="JSON with decisions[]; missing decisions pause for the agent")
    ap.add_argument("--max-queries", type=int, default=12, help="hard cap on search jobs; each job may fan out to configured providers")
    args = ap.parse_args()
    if args.max_queries < 1 or args.rounds < 1:
        ap.error("--max-queries and --rounds must be positive")

    out_dir = Path(args.out) if args.out else Path.home() / "Documents" / "deep-research" / f"run_{int(time.time())}"
    out_dir.mkdir(parents=True, exist_ok=True)

    planes = {p.strip() for p in args.planes.split(",") if p.strip()}
    width = normalize_width(args.width)
    profile, candidates, selected = profile_families(
        args.query,
        width,
        args.depth,
        max_queries=args.max_query_families,
        rounds=args.rounds,
    )
    fused: list[dict] = []
    family_runs: list[dict] = []
    meta = {
        "query": args.query,
        "out": str(out_dir),
        "planes": sorted(planes),
        "width": width,
        "depth": args.depth,
        "research_profile": profile,
        "query_family_candidates": candidates,
        "query_families": selected,
        "query_family_candidate_count": len(candidates),
        "query_family_count": len(selected),
        "started_at": datetime.now(timezone.utc).isoformat(),
    }
    (out_dir / "query_families.json").write_text(
        json.dumps(
            {"profile": profile, "candidates": candidates, "selected": selected},
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )

    def search_one(family: dict) -> tuple[list[dict], dict]:
        cache_key = hashlib.sha256(json.dumps({
            "query": family["query"], "planes": sorted(family.get("planes", planes)),
            "sites": family.get("sites", args.browser_sites), "pages": args.pages,
            "max_results": args.max_results_per_site, "days": args.last30_days,
            "last30_depth": args.last30_depth,
        }, sort_keys=True).encode()).hexdigest()
        cache = out_dir / "search-cache" / (cache_key + ".json")
        if cache.is_file():
            saved = json.loads(cache.read_text())
            return saved["items"], dict(saved["run"], cache_hit=True)
        result = run_query_family(
            family,
            out_dir,
            planes,
            args.browser_sites,
            args.lane,
            args.headless,
            args.last30_days,
            args.last30_depth,
            shared_root=width == "legacy" and args.rounds <= 1,
            max_results=args.max_results_per_site,
            pages=args.pages,
        )
        if result[0] and not result[1].get("errors"):
            cache.parent.mkdir(exist_ok=True)
            cache.write_text(json.dumps({"items": result[0], "run": result[1]}, ensure_ascii=False))
        return result

    def search_round(families: list[dict]) -> list[tuple[list[dict], dict]]:
        """Run one round's queries. Parallelism is within a round only:
        round N+1 depends on round N's results, so rounds are a barrier."""
        if args.no_parallel or len(families) <= 1:
            results = []
            for family in families:
                try:
                    results.append(search_one(family))
                except Exception as e:
                    print(f"[{family.get('family_id')}] exception {e}", file=sys.stderr)
                    results.append(([], {"family_id": family.get("family_id"), "hits": 0, "errors": [str(e)]}))
            return results

        ordered: list[tuple[list[dict], dict] | None] = [None] * len(families)
        workers = min(4, max(1, len(families)))
        with ThreadPoolExecutor(max_workers=workers) as ex:
            futs = {ex.submit(search_one, family): idx for idx, family in enumerate(families)}
            for fut in as_completed(futs):
                idx = futs[fut]
                try:
                    ordered[idx] = fut.result()
                except Exception as e:
                    name = families[idx].get("family_id")
                    print(f"[{name}] exception {e}", file=sys.stderr)
                    ordered[idx] = ([], {"family_id": name, "hits": 0, "errors": [str(e)]})
        return [row if row is not None else ([], {}) for row in ordered]

    if args.planner == "legacy":
        profile["stopping"]["max_queries"] = args.max_queries
        progressive = run_progressive(
            args.query, selected, profile, search_round, rounds=args.rounds,
            expansions_per_round=args.expansions_per_round,
            log=lambda msg: print(msg, file=sys.stderr))
    else:
        progressive = run_semantic(
            args.query, SemanticPlanner(out_dir, args.planner, args.query_plan), search_round,
            planes=planes, sites=set(args.browser_sites.split(",")), rounds=args.rounds,
            max_queries=args.max_queries,
            queries_per_round=args.max_query_families or profile["width"]["selected_queries"],
            log=lambda msg: print(msg, file=sys.stderr))
        # These are the families actually executed, not labels copied from the legacy planner.
        selected = progressive["family_runs"]
        meta.update(planner=args.planner, task=progressive["task"], relations=progressive["relations"],
                    information_needs=progressive["information_needs"],
                    review=progressive["review"], planner_error=progressive["planner_error"],
                    query_families=selected, query_family_candidates=[],
                    query_family_count=len(selected), query_family_candidate_count=0)
        profile["stopping"]["max_queries"] = args.max_queries
        profile["depth"]["max_branch_depth"] = args.rounds
        (out_dir / "query_families.json").write_text(json.dumps(
            {"profile": profile, "candidates": [], "selected": selected}, ensure_ascii=False, indent=2))
    fused = progressive["items"]
    family_runs = progressive["family_runs"]

    # Entities come from the corpus, never from the planner's own labels.
    fused = attach_mined_entities(fused, progressive["mined_terms"])

    fused = dedupe(fused)
    metrics = coverage_metrics(fused, selected)
    sources_path = out_dir / "sources.jsonl"
    with sources_path.open("w", encoding="utf-8") as f:
        for it in fused:
            f.write(json.dumps(it, ensure_ascii=False) + "\n")

    write_summary(out_dir / "summary.md", args.query, fused, metrics, profile, progressive)
    meta["finished_at"] = datetime.now(timezone.utc).isoformat()
    meta["unique_urls"] = len(fused)
    meta["query_family_runs"] = sorted(family_runs, key=lambda item: (item.get("round", 0), item.get("family_id", "")))
    meta["source_health"] = {
        item.get("family_id"): item.get("source_health", {})
        for item in family_runs
        if item.get("family_id")
    }
    meta["coverage"] = metrics
    meta["rounds"] = progressive["rounds"]
    meta["round_count"] = len(progressive["rounds"])
    meta["stop_reason"] = progressive["stop_reason"]
    meta["queries_used"] = progressive["queries_used"]
    meta["mined_terms"] = progressive["mined_terms"]
    # Discovery is reported separately from the planner's own plan so a run
    # cannot look complete merely by covering the families it invented.
    meta["discovery"] = {
        "mined_entity_count": len(progressive["mined_terms"]),
        "planned_family_coverage": metrics.get("family_coverage"),
        "expansion_queries": [
            {"query": run.get("query"), "provenance": run.get("provenance")}
            for run in family_runs
            if run.get("provenance")
        ],
    }
    meta["counts_by_plane"] = {}
    for it in fused:
        for p in it.get("planes") or [it.get("plane") or "?"]:
            meta["counts_by_plane"][p] = meta["counts_by_plane"].get(p, 0) + 1
    (out_dir / "manifest.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    # GPTR-friendly doc dump
    docs = out_dir / "gptr-docs"
    docs.mkdir(exist_ok=True)
    (docs / "sources.md").write_text(
        "\n\n".join(
            f"## {it.get('title') or it.get('url')}\n\n"
            f"URL: {it.get('url')}\n\n"
            f"Planes: {', '.join(it.get('planes') or [it.get('plane') or '?'])}\n\n"
            f"Query families: {', '.join(it.get('family_ids') or [it.get('family_id') or '?'])}\n\n"
            f"{it.get('snippet') or ''}"
            for it in [row for row in fused if row.get("relevant", True)][:args.max_docs]
        ),
        encoding="utf-8",
    )

    print(json.dumps({"out": str(out_dir), "unique_urls": len(fused), "rounds": len(progressive["rounds"]), "stop_reason": progressive["stop_reason"], "manifest": str(out_dir / "manifest.json")}, indent=2))
    return {"needs_query_plan": 3, "source_failure": 4}.get(progressive["stop_reason"], 0)


if __name__ == "__main__":
    raise SystemExit(main())
