#!/usr/bin/env python3
"""
Deep Research pipeline:

  multi-source search (smart-search + browser Google/Reddit/X + last30days)
    → evidence pack
    → GPT Researcher synthesis (hybrid local docs + optional web)
    → report.md

Usage:
  python deep_research.py "query" -o ~/Documents/deep-research/run1
  python deep_research.py "query" --planes smart,browser,last30days --no-gptr
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
MULTI = ROOT / "multi_source_search.py"
from runtime_config import env_file, load_config
GPTR_VENV_PY = Path(sys.executable)
GPTR_RUN = ROOT / "gptr_runner.py"
GPTR_ENV = env_file()

def load_env() -> None:
    load_config()


def run_multi(
    query: str,
    out: Path,
    planes: str,
    sites: str,
    lane: str,
    headless: bool,
    last30_days: int,
    last30_depth: str,
    width: str,
    depth: str,
    max_query_families: int | None,
    rounds: int = 3,
    expansions_per_round: int = 4,
    max_results_per_site: int = 30,
    pages: int = 1,
    planner: str = "auto",
    query_plan: str = "",
    max_queries: int = 12,
) -> dict:
    import subprocess

    cmd = [
        sys.executable,
        str(MULTI),
        query,
        "-o",
        str(out),
        "--planes",
        planes,
        "--browser-sites",
        sites,
        "--lane",
        lane,
        "--last30-days",
        str(last30_days),
        "--last30-depth",
        last30_depth,
        "--width",
        width,
        "--depth",
        depth,
        "--rounds",
        str(rounds),
        "--expansions-per-round",
        str(expansions_per_round),
        "--max-results-per-site",
        str(max_results_per_site),
        "--pages",
        str(pages),
        "--planner", planner,
        "--max-queries", str(max_queries),
    ]
    if query_plan:
        cmd.extend(["--query-plan", query_plan])
    if max_query_families is not None:
        cmd.extend(["--max-query-families", str(max_query_families)])
    if headless:
        cmd.append("--headless")
    p = subprocess.run(cmd, capture_output=True, text=True)
    sys.stderr.write(p.stderr or "")
    if p.returncode not in (0, 3, 4):
        raise RuntimeError(f"multi_source_search failed: {p.stdout}\n{p.stderr}")
    try:
        return json.loads(p.stdout.strip())
    except Exception:
        return {"out": str(out)}


async def gptr_synthesize(query: str, evidence_dir: Path, report_path: Path, report_type: str) -> str:
    """Use installed GPT Researcher with local evidence as DOC_PATH + hybrid."""
    load_env()
    # Point GPTR at collected docs; keep multi retrievers for supplementary web
    docs = evidence_dir / "gptr-docs"
    os.environ["DOC_PATH"] = str(docs)
    # Prefer hybrid so GPTR can use local pack + web retrievers
    sys.path.insert(0, str(Path.home() / ".venvs/gpt-researcher/lib/python3.11/site-packages"))
    # Prefer venv interpreter path for embeddings deps — import from current if available
    try:
        from gpt_researcher import GPTResearcher
    except ImportError:
        # re-exec under gptr venv
        if GPTR_VENV_PY.is_file():
            import subprocess

            cmd = [
                str(GPTR_VENV_PY),
                str(GPTR_RUN),
                f"{query}\n\nUse the local evidence documents under DOC_PATH as primary sources. "
                f"Evidence summary is in {evidence_dir / 'summary.md'}.",
                "--report-type",
                report_type,
                "--report-source",
                "hybrid",
                "-o",
                str(report_path),
            ]
            env = os.environ.copy()
            env["DOC_PATH"] = str(docs)
            p = subprocess.run(cmd, env=env)
            if p.returncode != 0:
                raise RuntimeError("gptr subprocess failed")
            return report_path.read_text(encoding="utf-8") if report_path.is_file() else ""
        raise

    researcher = GPTResearcher(
        query=(
            f"{query}\n\nPrimary evidence was pre-collected from smart-search, Tavily/Exa, "
            f"Chrome SERP (Google/Reddit/X), and last30days social/recency signals. "
            f"Prefer primary evidence for factual claims and use recent social sources for sentiment and discovery. "
            f"See local docs in DOC_PATH and {evidence_dir / 'summary.md'}."
        ),
        report_type=report_type,
        report_source="hybrid",
    )
    await researcher.conduct_research()
    report = await researcher.write_report()
    report_path.write_text(report, encoding="utf-8")
    return report


def simple_md_report(query: str, evidence_dir: Path, report_path: Path) -> str:
    """Fallback synthesis without GPTR — structured evidence memo."""
    summary = (evidence_dir / "summary.md").read_text(encoding="utf-8") if (evidence_dir / "summary.md").is_file() else ""
    sources = []
    sp = evidence_dir / "sources.jsonl"
    if sp.is_file():
        for line in sp.read_text(encoding="utf-8").splitlines():
            try:
                sources.append(json.loads(line))
            except Exception:
                pass
    body = [
        f"# Deep Research (evidence pack): {query}",
        "",
        "> Generated by Deep Research multi-source fusion. Optional GPTR synthesis skipped or unavailable.",
        "",
        "## Evidence summary",
        "",
        summary,
        "",
        "## Source table",
        "",
        "| # | Plane | Title | URL |",
        "|---|-------|-------|-----|",
    ]
    for i, s in enumerate(sources[:40], 1):
        title = (s.get("title") or "").replace("|", " ")[:80]
        body.append(f"| {i} | {s.get('plane')} | {title} | {s.get('url')} |")
    text = "\n".join(body) + "\n"
    report_path.write_text(text, encoding="utf-8")
    return text


def main() -> int:
    ap = argparse.ArgumentParser(description="Deep Research fused pipeline")
    ap.add_argument("query")
    ap.add_argument("-o", "--out", default="")
    ap.add_argument("--planes", default="smart,browser,last30days")
    ap.add_argument(
        "--browser-sites",
        default="google,reddit,x,sogou-weixin",
        help="google,reddit,x,sogou-weixin (weixin.sogou.com)",
    )
    ap.add_argument("--lane", default="cdp-browser-daemon")
    ap.add_argument("--headless", action="store_true")
    ap.add_argument("--last30-days", type=int, default=30, choices=range(1, 31))
    ap.add_argument(
        "--last30-depth",
        choices=["quick", "standard", "deep"],
        default="quick",
    )
    ap.add_argument(
        "--width",
        "--breadth",
        choices=["legacy", "narrow", "standard", "wide", "deep-wide"],
        default="standard",
        help="independent query-path width; legacy preserves the prior single-query route",
    )
    ap.add_argument(
        "--depth",
        choices=["fast", "standard", "deep"],
        default="standard",
        help="research branch depth, independent from width",
    )
    ap.add_argument("--max-query-families", type=int, default=None)
    ap.add_argument(
        "--rounds",
        type=int,
        default=3,
        help="search/review iterations; at least 2 for resolve then discover",
    )
    ap.add_argument("--expansions-per-round", type=int, default=4)
    ap.add_argument("--max-results-per-site", type=int, default=30)
    ap.add_argument("--pages", type=int, default=1)
    ap.add_argument("--planner", choices=["auto", "agent", "legacy"], default="agent")
    ap.add_argument("--query-plan", default="")
    ap.add_argument("--max-queries", type=int, default=12)
    ap.add_argument("--no-gptr", action="store_true", help="only multi-source evidence pack")
    ap.add_argument(
        "--report-type",
        default="research_report",
        choices=["research_report", "detailed_report", "deep", "outline_report"],
    )
    args = ap.parse_args()

    out = Path(args.out) if args.out else ROOT.parent / "outputs" / f"run_{int(time.time())}"
    out.mkdir(parents=True, exist_ok=True)
    print(f"[deep-research] evidence → {out}", file=sys.stderr)

    meta = run_multi(
        args.query,
        out,
        args.planes,
        args.browser_sites,
        args.lane,
        args.headless,
        args.last30_days,
        args.last30_depth,
        args.width,
        args.depth,
        args.max_query_families,
        args.rounds,
        args.expansions_per_round,
        args.max_results_per_site,
        args.pages,
        args.planner,
        args.query_plan,
        args.max_queries,
    )
    print(json.dumps(meta, indent=2), file=sys.stderr)
    if meta.get("stop_reason") == "needs_query_plan":
        print(f"[deep-research] planner needs agent input: {out / 'planner_request.json'}", file=sys.stderr)
        return 3

    if meta.get("stop_reason") == "source_failure":
        print("[deep-research] retrieval failed; inspect manifest.json before synthesis", file=sys.stderr)
        return 4

    report_path = out / "report.md"
    if args.no_gptr:
        simple_md_report(args.query, out, report_path)
        print(f"[deep-research] report (evidence-only) → {report_path}", file=sys.stderr)
        print(str(report_path))
        return 0

    try:
        # Prefer subprocess to GPTR venv (has all deps)
        if GPTR_VENV_PY.is_file() and GPTR_RUN.is_file():
            import subprocess

            load_env()
            docs = out / "gptr-docs"
            # Merge summary into local docs so report_source=local has enough signal
            docs.mkdir(exist_ok=True)
            summary_path = out / "summary.md"
            if summary_path.is_file():
                (docs / "00_summary.md").write_text(
                    summary_path.read_text(encoding="utf-8"), encoding="utf-8"
                )
            sources_path = out / "sources.jsonl"
            if sources_path.is_file():
                lines = []
                for i, line in enumerate(sources_path.read_text(encoding="utf-8").splitlines()[:50], 1):
                    try:
                        it = json.loads(line)
                    except Exception:
                        continue
                    lines.append(
                        f"### {i}. {it.get('title') or it.get('url')}\n\n"
                        f"- URL: {it.get('url')}\n"
                        f"- Plane: {it.get('plane')}\n\n"
                        f"{it.get('snippet') or ''}\n"
                    )
                (docs / "01_sources.md").write_text("\n".join(lines), encoding="utf-8")

            env = os.environ.copy()
            env["DOC_PATH"] = str(docs)
            env["GPTR_SAFE_EMBEDDING"] = "1"
            env["EMBEDDING"] = "openai:text-embedding-3-small"
            env["TOKENIZERS_PARALLELISM"] = "false"
            env["OMP_NUM_THREADS"] = "1"
            # local synthesis: avoid second fragile web scrape round
            # (evidence already collected by multi_source_search)
            env["RETRIEVER"] = env.get("RETRIEVER") or "tavily"
            q = args.query.strip()
            log_path = out / "gptr_stderr.log"
            cmd = [
                str(GPTR_VENV_PY),
                str(GPTR_RUN),
                q,
                "--report-type",
                args.report_type,
                "--report-source",
                "local",
                "--no-bridge",
                "-o",
                str(report_path),
            ]
            print(
                f"[deep-research] running optional GPT Researcher synthesis (local docs)… log={log_path}",
                file=sys.stderr,
            )
            with log_path.open("w", encoding="utf-8") as logf:
                p = subprocess.run(cmd, env=env, stdout=logf, stderr=subprocess.STDOUT)
            if p.returncode != 0 or not report_path.is_file():
                reason = {
                    139: "SIGSEGV (process crash — often embeddings/torch)",
                    137: "SIGKILL (OOM or killed)",
                    -11: "SIGSEGV",
                }.get(p.returncode, f"exit={p.returncode}")
                print(
                    f"[deep-research] GPTR failed ({reason}) → evidence-only report; see {log_path}",
                    file=sys.stderr,
                )
                # tail log for operator
                try:
                    tail = log_path.read_text(encoding="utf-8", errors="replace")[-1200:]
                    if tail.strip():
                        print(tail, file=sys.stderr)
                except Exception:
                    pass
                simple_md_report(args.query, out, report_path)
            else:
                print(f"[deep-research] GPTR draft ok → {report_path}", file=sys.stderr)
        else:
            asyncio.run(gptr_synthesize(args.query, out, report_path, args.report_type))
    except Exception as e:
        print(f"[deep-research] synthesis error: {e}", file=sys.stderr)
        simple_md_report(args.query, out, report_path)

    # attach evidence pointer
    if report_path.is_file():
        extra = f"\n\n---\n\n## Evidence pack\n\n- dir: `{out}`\n- summary: `{out / 'summary.md'}`\n- sources: `{out / 'sources.jsonl'}`\n"
        report_path.write_text(report_path.read_text(encoding="utf-8") + extra, encoding="utf-8")

    print(str(report_path))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
