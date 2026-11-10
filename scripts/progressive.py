#!/usr/bin/env python3
"""Progressive (multi-round) retrieval loop.

The old route fanned one long query out to every plane in a single shot and
stopped.  That fails for two reasons: search engines approximate AND semantics
so a long query returns little, and nothing was ever learned from the results.

This module implements the loop the methodology docs already described:

    round 0   short probes built only from the user's own vocabulary
       |      read WIDE (many results per engine)
       v
    mine      pull real vocabulary out of the retrieved titles/snippets
       |
       v
    round N   seed x mined term -> new short queries, each carrying provenance
       |      back to the document its term came from
       v
    stop      when new entities/URLs dry up or the query budget is spent

It is deliberately free of network and model dependencies: the caller injects a
`search_fn`, so the loop is testable offline with a fixture corpus.
"""
from __future__ import annotations

from typing import Callable, Sequence

from breadth import (
    annotate_items,
    enforce_query_budget,
    mine_terms,
    plan_expansion_queries,
    should_stop,
)

# A batch search callable: (families) -> [(items, run_record), ...]
# Batch rather than single-query so the caller can fan out WITHIN a round.
# Rounds themselves are a barrier: round N+1's queries are derived from round
# N's results, so they cannot overlap.
SearchFn = Callable[[Sequence[dict]], list[tuple[list[dict], dict]]]


def _canonical_url(url: str) -> str:
    return str(url or "").split("#", 1)[0].rstrip("/")


def _seed_vocabulary(query: str, families: Sequence[dict]) -> set[str]:
    """Words already in play, which must not be re-mined as discoveries."""
    vocab: set[str] = set()
    for text in [query, *(family.get("query", "") for family in families)]:
        for term in str(text or "").split():
            cleaned = term.strip("\"',.:;()[]").lower()
            if cleaned:
                vocab.add(cleaned)
    return vocab


def run_progressive(
    query: str,
    families: Sequence[dict],
    profile: dict,
    search_fn: SearchFn,
    *,
    rounds: int = 2,
    expansions_per_round: int = 4,
    max_terms: int = 5,
    log: Callable[[str], None] | None = None,
) -> dict:
    """Drive probe -> mine -> expand until a stopping gate fires.

    Returns {"items", "rounds", "family_runs", "stop_reason", "mined_terms"}.
    """
    emit = log or (lambda _msg: None)
    all_items: list[dict] = []
    family_runs: list[dict] = []
    round_records: list[dict] = []
    seen_urls: set[str] = set()
    seen_terms: set[str] = set()
    seen_mined: set[str] = set()
    seed_vocab = _seed_vocabulary(query, families)
    queries_used = 0
    stop_reason = ""

    current: list[dict] = [dict(family, round=0) for family in families]

    for round_index in range(max(1, rounds)):
        budget = int(profile.get("stopping", {}).get("max_queries") or 0)
        if budget:
            current = current[:max(0, budget - queries_used)]
            if not current:
                stop_reason = "query_budget"
                break
        if not current:
            stop_reason = stop_reason or "no_new_queries"
            break

        round_items: list[dict] = []
        try:
            results = search_fn(current)
        except Exception as exc:  # a whole-round failure must not kill the loop
            results = []
            family_runs.append({"round": round_index, "hits": 0, "errors": [str(exc)]})
            emit(f"[round {round_index}] batch failed: {exc}")
        queries_used += len(current)
        for family, (items, run) in zip(current, results):
            run = dict(run)
            run["round"] = round_index
            run["provenance"] = family.get("provenance") or {}
            family_runs.append(run)
            round_items.extend(items)

        new_urls = {
            _canonical_url(item.get("url"))
            for item in round_items
            if item.get("url") and _canonical_url(item.get("url")) not in seen_urls
        }
        seen_urls.update(new_urls)
        all_items.extend(round_items)

        # Mine vocabulary from THIS round's documents only, excluding anything
        # already used as a query term (otherwise the loop echoes itself).
        mined = mine_terms(round_items, seed_terms=seed_vocab, limit=expansions_per_round * 3)
        fresh_terms = [row for row in mined if row["term"].lower() not in seen_terms]
        new_entity_rate = (
            len([row for row in mined if row["term"].lower() not in seen_mined]) / len(mined) if mined else 0.0
        )
        seen_mined.update(row["term"].lower() for row in mined)
        new_url_rate = len(new_urls) / len(round_items) if round_items else 0.0

        record = {
            "round_index": round_index,
            "queries": [family.get("query") for family in current],
            "query_count": len(current),
            "hits": len(round_items),
            "new_urls": len(new_urls),
            "new_url_rate": round(new_url_rate, 4),
            "new_entities": len(fresh_terms),
            "new_entity_rate": round(new_entity_rate, 4),
            "mined_terms": [row["term"] for row in fresh_terms[:expansions_per_round]],
            "mined_detail": fresh_terms[:expansions_per_round],
        }
        round_records.append(record)
        emit(
            f"[round {round_index}] queries={len(current)} hits={len(round_items)} "
            f"new_urls={len(new_urls)} mined={record['mined_terms']}"
        )

        stop, reason = should_stop(round_records, profile, queries_used=queries_used)
        if stop:
            stop_reason = reason
            break
        if round_index + 1 >= max(1, rounds):
            stop_reason = stop_reason or "rounds_exhausted"
            break

        # Build the next round from mined vocabulary.
        expansions = plan_expansion_queries(
            query,
            fresh_terms,
            max_queries=expansions_per_round,
            terms_per_query=max_terms,
        )
        if not expansions:
            stop_reason = "no_new_terms"
            break

        current = []
        for idx, expansion in enumerate(expansions):
            term = expansion["provenance"].get("term", "")
            if term:
                seen_terms.add(term.lower())
            try:
                budgeted = enforce_query_budget(expansion["query"], max_terms)
            except ValueError:
                continue
            # Inherit routing from the round-0 family mix so expansions still
            # spread across planes rather than all hitting the same site.
            parent = families[idx % len(families)] if families else {}
            current.append(
                {
                    "family_id": f"r{round_index + 1}-{idx + 1:02d}-expand",
                    "query": budgeted,
                    "dimension": parent.get("dimension", "expansion"),
                    "dimension_label": parent.get("dimension_label", ""),
                    "topic": f"expansion: {term}",
                    "perspective": parent.get("perspective", "neutral"),
                    "source_strategy": parent.get("source_strategy", ""),
                    "provenance": expansion["provenance"],
                    "round": round_index + 1,
                    "rank": idx + 1,
                }
            )
    else:  # pragma: no cover - loop always breaks above
        stop_reason = stop_reason or "rounds_exhausted"

    # Entities are the terms we actually mined from documents, never planner
    # labels. Attach them to the run so coverage reflects real discovery.
    mined_all = mine_terms(all_items, seed_terms=seed_vocab, limit=60)
    return {
        "items": all_items,
        "rounds": round_records,
        "family_runs": family_runs,
        "stop_reason": stop_reason or "rounds_exhausted",
        "queries_used": queries_used,
        "mined_terms": mined_all,
    }


def attach_mined_entities(items: Sequence[dict], mined: Sequence[dict]) -> list[dict]:
    """Tag each item with the mined entities that occur in its own text."""
    terms = [(row["term"], row["term"].lower()) for row in mined if row.get("term")]
    out: list[dict] = []
    for item in items:
        row = dict(item)
        haystack = f"{row.get('title') or ''} {row.get('snippet') or ''}".lower()
        found = [display for display, lowered in terms if lowered in haystack]
        if found:
            existing = list(row.get("entities") or [])
            for name in found:
                if name not in existing:
                    existing.append(name)
            row["entities"] = existing
        out.append(row)
    return out


__all__ = ["run_progressive", "attach_mined_entities", "annotate_items"]
