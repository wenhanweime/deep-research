#!/usr/bin/env python3
"""Run a deterministic old-vs-width-aware breadth comparison on a fixture."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from breadth import coverage_metrics


def load_fixture(path: Path) -> list[dict]:
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            rows.append(json.loads(line))
    return rows


def families_for(rows: list[dict]) -> list[dict]:
    families = {}
    for row in rows:
        fid = row.get("family_id")
        if not fid:
            continue
        families.setdefault(
            fid,
            {
                "family_id": fid,
                "dimension": fid.split("-", 1)[1] if "-" in fid else fid,
            },
        )
    return list(families.values())


def compare(rows: list[dict]) -> dict:
    old = [row for row in rows if row.get("old_visible")]
    new = [row for row in rows if row.get("new_visible")]
    # Both routes are judged against the same discovered target axes.  This
    # makes the old single-path denominator visible instead of giving it a
    # perfect score merely because its own plan was tiny.
    planned_families = families_for(rows)
    old_metrics = coverage_metrics(old, planned_families)
    new_metrics = coverage_metrics(new, planned_families)
    numeric_delta = {
        key: round(new_metrics[key] - old_metrics[key], 4)
        for key in (
            "unique_urls",
            "entity_count",
            "topic_count",
            "perspective_count",
            "source_type_count",
            "domain_count",
            "family_coverage",
            "aspect_coverage",
            "path_diversity",
            "trajectory_overlap",
        )
    }
    return {
        "fixture": "vibecoding_dashboard_corpus.jsonl",
        "method": "old single-query visibility vs width-aware query-family visibility",
        "old": old_metrics,
        "new": new_metrics,
        "delta": numeric_delta,
        "measured": True,
        "inferred": [
            "The fixture demonstrates metric behavior, not live web recall.",
            "Higher coverage is useful only if evidence quality and claim support remain hard constraints.",
        ],
        "not_evidenced": [
            "Real-world entity recall for all vibecoding dashboard products.",
            "Whether the live browser and social planes return the fixture's long-tail items.",
        ],
    }


def write_outputs(comparison: dict, out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    (out / "comparison.json").write_text(json.dumps(comparison, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    old, new, delta = comparison["old"], comparison["new"], comparison["delta"]
    manifest = {
        "experiment": "deep-research width x depth v2",
        "case": "vibecoding management dashboard products",
        "fixture": comparison["fixture"],
        "method": comparison["method"],
        "old_route": {"width": "legacy", "query_families": old["query_families_hit"]},
        "new_route": {"width": "width-aware", "query_families": new["query_families_hit"]},
        "measured_delta": delta,
        "artifacts": ["manifest.json", "comparison.json", "summary.md", "report.md", "tests.log", "evaluate.log"],
        "verification_command": "python3 -m unittest discover -s tests -v",
        "evidence_status": {
            "measured": "fixture metrics and local unit/integration tests",
            "inferred": comparison["inferred"],
            "not_evidenced": comparison["not_evidenced"],
        },
    }
    (out / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    summary = [
        "# Width x Depth v2 fixture comparison",
        "",
        "The fixture compares the previous single-query route with the width-aware query-family route for a vibecoding management dashboard landscape.",
        "",
        "## Measured results",
        "",
        "| Metric | Old | New | Delta |",
        "|---|---:|---:|---:|",
    ]
    for key, label in (
        ("unique_urls", "unique URLs"),
        ("entity_count", "entities"),
        ("topic_count", "topics"),
        ("perspective_count", "perspectives"),
        ("source_type_count", "source types"),
        ("domain_count", "domains"),
        ("family_coverage", "family coverage"),
        ("aspect_coverage", "aspect coverage"),
        ("path_diversity", "path diversity"),
        ("trajectory_overlap", "trajectory overlap"),
    ):
        summary.append(f"| {label} | {old[key]} | {new[key]} | {delta[key]} |")
    summary += [
        "",
        "## Interpretation boundaries",
        "",
        "- Measured: all values in the table are computed from the checked-in fixture.",
        "- Inferred: width-aware query families expose more labelled dimensions and source paths in this corpus.",
        "- Not evidenced: live recall, source correctness, and comprehensive product enumeration.",
        "",
        "See `comparison.json` for full coverage sets and the explicit evidence boundaries.",
    ]
    (out / "summary.md").write_text("\n".join(summary) + "\n", encoding="utf-8")
    report = "\n".join(
        [
            "# Vibecoding management dashboard breadth evaluation",
            "",
            "## Test design",
            "",
            "The old route is represented by six records returned from one seed family. The new route is represented by the same seed records plus independently labelled integration, community, adjacent, recent, deployment, mobile, pricing, risk, regional, evaluation, failure, long-tail, stakeholder, cross-domain, history, alternatives, and accessibility records.",
            "",
            "## Result",
            "",
            f"The fixture grows unique URLs from {old['unique_urls']} to {new['unique_urls']}, entities from {old['entity_count']} to {new['entity_count']}, perspectives from {old['perspective_count']} to {new['perspective_count']}, and source types from {old['source_type_count']} to {new['source_type_count']}. Path diversity changes from {old['path_diversity']} to {new['path_diversity']}.",
            "",
            "This is an implementation regression fixture, not a claim that the live web contains exactly these products. The live pipeline must still pass source verification and unknown-entity coverage gates.",
            "",
            "## Evidence status",
            "",
            "- Measured: `comparison.json` values and the unit tests.",
            "- Inferred: separating query paths should make width observable and allow marginal coverage accounting.",
            "- Not evidenced: absolute recall, product-market completeness, or live plane quality.",
            "",
        ]
    )
    (out / "report.md").write_text(report, encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixture", default=str(Path(__file__).resolve().parents[1] / "tests/fixtures/vibecoding_dashboard_corpus.jsonl"))
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    comparison = compare(load_fixture(Path(args.fixture)))
    write_outputs(comparison, Path(args.out))
    print(json.dumps(comparison, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
