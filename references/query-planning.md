# Semantic query planning

The default runner uses `--planner agent`: the current research agent identifies
what must be learned, chooses how to search it, then reviews actual evidence.
The default output is a sourced account of concepts, facts, mechanisms, viewpoints
and remaining uncertainty. Choose information needs for the current question;
examples and past tasks do not provide its vocabulary or constraints.
The script validates and executes decisions; it does not generate semantic
understanding by counting terms. API planning is an optional alternative.

## Planning decisions

Start with goal, answer type, hard constraints, preferences and unknowns. Create
`information_needs`: each has a stable `id`, an answerable `question`,
`answer_criteria`, `depends_on` IDs, status `open|answered|blocked`, and observed
`evidence_urls`. A clear request can have one need and search immediately.
Split unrelated questions; model true dependencies only. The validator rejects
cycles, missing prerequisites, disappearing needs, and an answered status without
observed evidence. Each new query names its `need_id`; its dependencies must be
answered. This checks structure/provenance, not the truth of the answers.

Choose transformations according to the information gap:

| Gap | Useful query action |
|---|---|
| Unknown identity or ambiguity | Resolve identity; preserve disambiguating context |
| Everyday wording differs from documents | Map to technical terms or other source language |
| Known example hides the solution category | Broaden to function, category or mechanism |
| Answer lies across an entity relationship | Resolve that relationship, then replace the anchor |
| Comparison or multi-part question | Search independent criteria separately; retain shared constraints |
| Causal or contested claim | Search measurements, study design and counterevidence |
| Exact error, code, title or quotation | Preserve it as a `literal` concept; do not truncate discriminating text |
| Sparse, irrelevant or repetitive returns | Change anchor/terms/source, or relax an optional qualifier |

Prefer 1–2 concepts when useful; the current contract caps at 3, with phrases
inside a concept. This is not a universal word-count rule. Exact literals may be
longer and are quoted by the renderer. Do not package the whole natural-language
brief as a quoted literal. Hard constraints survive even when omitted from search
keywords; verify them in the final answer. New entity claims need evidence;
hypothesis-testing queries may introduce a candidate for resolution.

## Modes and configuration

- `auto` (optional standalone API planner): use existing GPTR `SMART_LLM` / `FAST_LLM`, `OPENAI_BASE_URL`,
  `OPENAI_API_KEY`. Override with `DEEP_RESEARCH_PLANNER_MODEL`,
  `DEEP_RESEARCH_PLANNER_BASE_URL`, `DEEP_RESEARCH_PLANNER_API_KEY`.
  An unavailable primary can use one configured Smart Search compatible model.
  An explicit planner base override disables that fallback.
- `agent` (default): the current agent supplies decisions. No extra model credentials needed.
- `legacy`: explicit deterministic regression mode. Its term counting and mining
  are not semantic understanding; do not use it to claim this failure is solved.

Never print credentials or copy them into plans/manifests.

## Evidence contract

The complete schema and planner prompt are in `scripts/query_planner.py`.
Each new decision contains `task`, `information_needs`, `relations`, `review`, and
`queries`. Old plans without information_needs remain replayable; do not use that
compatibility format for new planning.
Every query contains noun `concepts` (text + kind), purpose, operation, rationale,
evidence_urls, planes and sites. The runner constructs the query text itself.

A new entity used in discovery must occur in supplied query evidence; otherwise
schedule a resolve query. A verified relationship requires a real retrieved URL
and an observed quote. This validates provenance, not truth: read the primary page
before relying on the relationship or recommending a candidate. Hypotheses and
user-supplied statements are recorded separately.

Review relevant/context sources separately from irrelevant sources, and put only
target candidates into `review.candidates`. Names must occur in relevant evidence.
A context entity is not necessarily an answer candidate. Fact/explanation tasks
may have an empty candidates list; assess the answer criteria instead. Sparse, off-target and
duplicate results should trigger a different anchor or route. CAPTCHA, timeout and
empty_or_failed sources cannot support an absence or convergence claim.

## Agent planning / resume

If the runner returns exit 3 and `stop_reason=needs_query_plan`, read
`planner_request.json` and the schema in `query_planner.py`, then write a JSON file:

```json
{
  "decisions": [
    {
      "task": {"target": "概念定义与研究文献", "intent": "理解当前研究主题", "hard_constraints": [], "preferences": [], "unknowns": ["核心定义与证据分歧"]},
      "information_needs": [{"id": "definition", "question": "该主题的核心概念如何定义？", "answer_criteria": "一手文献中的定义与适用范围", "depends_on": [], "status": "open", "evidence_urls": []}],
      "relations": [],
      "review": {"relevant_urls": [], "rejected": [], "candidates": [], "gaps": ["需要概念定义的一手来源"], "constraints_unknown": [], "sufficient": false},
      "queries": [
        {
          "need_id": "definition",
          "concepts": [{"text": "当前主题的核心术语", "kind": "category"}],
          "purpose": "discover", "operation": "refine", "rationale": "查找概念定义的原始来源",
          "evidence_urls": [], "planes": ["smart"], "sites": ["google"]
        }
      ]
    }
  ]
}
```

Replace the example with the actual request; do not invent evidence.
Before resuming, copy prior accepted plans from `planner_decisions.jsonl` in decision_index order,
then append the requested decision. Resume with the same query, output directory,
round/query budget and planes plus `--planner agent --query-plan plan.json`.
Successful searches are cached in that output directory, so replaying decisions
does not repeat those network requests. The decision log is recreated per invocation.
Failed searches are not treated as success.
Never supply unobserved future results to a prewritten later decision.

A final request (`final=true`, query_limit=0) reviews the last batch and must have
queries=[]. Complete that review before synthesis. If the API remains unavailable,
the agent should fill the plan; do not silently fall back to legacy or ask the user
to author a JSON plan.

## Controls and outputs

Defaults: width standard (up to 4 queries per round), rounds 3, max_queries 12.
These are ceilings, not quotas. Only dependent queries wait for prerequisite evidence; independent queries can
share a batch. Older plans defer initial discovery only when it shares an entity
with a resolve probe. `--max-query-families` caps queries per round;
`--max-queries` is the hard cap across rounds, including failed dispatched jobs.
One job may fan out to its selected providers: it is not an HTTP request or token
budget. Repeated query/provider pairs are removed before dispatch, including
overlap in the same batch. `--no-parallel` changes scheduling only.

Inspect `planner_decisions.jsonl`, task/relations/review in manifest,
`rounds[].new_entities`, `new_relevant_urls`, source_health, and actual
query_family_runs. The candidate novelty rate is computed against cumulative
observed candidates, not against a list already filtered to novel terms.
Coverage family labels do not prove recall.

Semantic stop reasons:
- evidence_sufficient: the planner reviewed the final evidence, declared no gaps
  or unresolved constraints, and the final round was healthy. The agent must still
  verify substantive claims; this is not proof of exhaustive coverage.
- rounds_exhausted / query_budget: unfinished search, report remaining gaps.
- source_failure (exit 4): unhealthy empty retrieval; synthesis is skipped. This is not evidence of absence.
- no_new_queries: no fresh query/provider route; check whether the plan needs widening.
- needs_query_plan: paused for agent planning, not a completed research report.

Legacy saturation reasons are local observations only. Never infer comprehensive
coverage just because new words or URLs stopped appearing.
