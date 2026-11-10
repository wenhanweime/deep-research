#!/usr/bin/env python3
"""Evidence-aware plan/search/review loop shared by CLI and offline evaluation."""
from __future__ import annotations

from datetime import datetime, timezone

from query_planner import PlanNeeded, merge_evidence, norm


def run_semantic(query, planner, search_fn, *, planes, sites, rounds=3,
                 max_queries=12, queries_per_round=4, log=None):
    emit = log or (lambda _: None)
    items, runs, records, decisions = [], [], [], []
    task, relations, relevant, rejected, candidates = {}, {}, set(), {}, {}
    information_needs = []
    executed = set()
    queries_used, decision_index = 0, 0
    stop_reason, planner_error = "rounds_exhausted", ""
    seen_urls, seen_candidates = set(), set()
    seen_relevant = set()
    review = {"gaps": [], "constraints_unknown": [], "sufficient": False}
    pending = None

    def context(final=False):
        return {"query": query, "task": task, "relations": list(relations.values()),
                "information_needs": information_needs,
                "evidence": merge_evidence(items), "last_round": records[-1] if records else None,
                "history": [{"query": r.get("query"), "planes": r.get("planes"),
                             "sites": r.get("sites"), "source_health": r.get("source_health")}
                            for r in runs],
                "available_planes": sorted(planes), "available_sites": sorted(sites),
                "query_limit": 0 if final else min(queries_per_round, max_queries - queries_used),
                "decision_index": decision_index, "final": final,
                "date": datetime.now(timezone.utc).date().isoformat()}

    def decide(final=False):
        nonlocal task, decision_index, review, pending, information_needs
        pending = context(final)
        plan = planner.decide(pending)
        decisions.append(plan)
        decision_index += 1
        task = plan["task"]
        information_needs = plan.get("information_needs", [])
        for relation in plan["relations"]:
            key = (norm(relation["subject"]), relation["relation"], norm(relation["object"]))
            relations[key] = relation
        review = plan["review"]
        relevant.update(review["relevant_urls"])
        for row in review.get("rejected", []):
            rejected[row["url"]] = row["reason"]
            relevant.discard(row["url"])
        for row in review["candidates"]:
            if row["evidence_url"] not in rejected:
                candidates[norm(row["name"])] = row
        # Revoking a source revokes candidate claims supported only by that source.
        for key in list(candidates):
            if candidates[key]["evidence_url"] not in relevant:
                del candidates[key]
        if records:
            record = records[-1]
            new = set(candidates) - seen_candidates
            record["new_entities"] = len(new)
            record["new_entity_rate"] = round(len(new) / max(1, len(candidates)), 4)
            record["candidate_count"] = len(candidates)
            current_relevant = set(record["result_urls"]) & relevant
            record["new_relevant_urls"] = len(current_relevant - seen_relevant)
            seen_relevant.update(current_relevant)
            record["gaps"] = review["gaps"]
            seen_candidates.update(candidates)
        return plan

    def sufficient():
        return bool(items and review.get("sufficient") and not review.get("gaps")
                    and not review.get("constraints_unknown")
                    and records and records[-1]["healthy"])

    try:
        for round_index in range(max(1, rounds)):
            plan = decide()
            if sufficient():
                stop_reason = "evidence_sufficient"
                break
            families = []
            scheduled = set(executed)
            planned = plan["queries"]
            # New plans use explicit information dependencies, validated before
            # dispatch. For older plans, defer only discovery sharing an entity
            # with an initial resolve probe; unrelated branches remain runnable.
            if not items and not information_needs:
                unresolved = {norm(c["text"]) for row in planned if row["purpose"] == "resolve"
                              for c in row["concepts"] if c["kind"] == "entity"}
                planned = [row for row in planned if row["purpose"] == "resolve"
                           or not any(c["kind"] == "entity" and norm(c["text"]) in unresolved
                                      for c in row["concepts"])]
            for row in planned:
                # Deduplicate the actual query and each provider, independent of
                # planner family labels. Browser sites are distinct providers.
                key = norm(row["query"])
                available, browser_sites = [], []
                for plane in row["planes"]:
                    providers = row["sites"] if plane == "browser" else [plane]
                    fresh = [p for p in providers if (key, plane, p) not in scheduled]
                    if fresh:
                        available.append(plane)
                        if plane == "browser":
                            browser_sites = fresh
                if not available:
                    continue
                if queries_used + len(families) >= max_queries:
                    break
                family = dict(row, family_id=f"r{round_index}-{len(families)+1:02d}-semantic",
                              dimension=row["purpose"], topic=task["target"],
                              perspective="user", source_strategy="semantic plan",
                              planes=available, sites=browser_sites,
                              round=round_index, rank=len(families)+1,
                              provenance={"operation": row["operation"],
                                          "need_id": row.get("need_id"),
                                          "evidence_urls": row["evidence_urls"]})
                families.append(family)
                for plane in family["planes"]:
                    for provider in family["sites"] if plane == "browser" else [plane]:
                        scheduled.add((key, plane, provider))
            if not families:
                stop_reason = "query_budget" if queries_used >= max_queries else "no_new_queries"
                break
            # Charge attempted jobs before dispatch, including failed requests.
            queries_used += len(families)
            for family in families:
                for plane in family["planes"]:
                    for provider in family["sites"] if plane == "browser" else [plane]:
                        executed.add((norm(family["query"]), plane, provider))
            try:
                results = search_fn(families)
            except Exception as exc:
                results = [([], {"errors": [type(exc).__name__]}) for _ in families]
            result_urls, round_healthy = set(), True
            for index, family in enumerate(families):
                batch, run = results[index] if index < len(results) else ([], {"errors": ["missing batch result"]})
                run = dict(run, family_id=family["family_id"], query=family["query"],
                           round=round_index, planes=family["planes"], sites=family["sites"],
                           provenance=family["provenance"], purpose=family["purpose"])
                health = run.get("source_health") or {}
                statuses = [health.get(p, {}).get("status") for p in family["planes"]]
                healthy = not run.get("errors") and (all(s == "ok" for s in statuses) if health else bool(batch))
                round_healthy = round_healthy and healthy
                runs.append(run)
                for item in batch:
                    row = dict(item, family_id=family["family_id"], purpose=family["purpose"])
                    items.append(row)
                    if row.get("url"):
                        result_urls.add(row["url"])
            new_urls = result_urls - seen_urls
            seen_urls.update(result_urls)
            records.append({"round_index": round_index, "queries": [f["query"] for f in families],
                            "query_count": len(families), "hits": sum(len(b) for b, _ in results),
                            "result_urls": sorted(result_urls), "new_urls": len(new_urls),
                            "new_url_rate": len(new_urls) / max(1, len(result_urls)),
                            "new_entities": 0, "new_entity_rate": 0,
                            "mined_terms": [], "healthy": round_healthy})
            emit(f"[semantic round {round_index}] queries={len(families)} urls={len(result_urls)}")
            if queries_used >= max_queries or round_index + 1 >= max(1, rounds):
                decide(final=True)
                stop_reason = "evidence_sufficient" if sufficient() else (
                    "source_failure" if not result_urls and not round_healthy else
                    "query_budget" if queries_used >= max_queries else "rounds_exhausted")
                break
        # Do not label an empty/failed search as convergence.
        if records and not records[-1]["result_urls"] and not records[-1]["healthy"]:
            stop_reason = "source_failure"
    except PlanNeeded as exc:
        stop_reason, planner_error = "needs_query_plan", str(exc)

    accepted_candidates = list(candidates.values())
    for item in items:
        item["relevant"] = item.get("url") in relevant
        if item.get("url") in rejected:
            item["rejection_reason"] = rejected[item["url"]]
        item["entities"] = [x["name"] for x in accepted_candidates
                            if x["evidence_url"] == item.get("url")]
    return {"items": items, "rounds": records, "family_runs": runs,
            "queries_used": queries_used, "stop_reason": stop_reason,
            "mined_terms": [{"term": x["name"], "sample_url": x["evidence_url"],
                             "doc_freq": 1, "freq": 1} for x in accepted_candidates],
            "task": task, "information_needs": information_needs,
            "relations": list(relations.values()), "review": review,
            "decisions": decisions, "planner_error": planner_error,
            "pending_request": pending if planner_error else None}
