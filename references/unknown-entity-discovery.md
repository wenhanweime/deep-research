# Unknown-Entity Discovery Gate

Apply this gate only to requests that require discovering, cataloging, comparing,
ranking or recommending named entities. Conceptual research, factual questions,
mechanism explanations and literature collection use task-specific information
needs and source criteria; they do not require a candidate catalog or the quotas
below. This gate prevents an entity landscape from being limited to user-supplied names.

The default semantic planner resolves entities, rewrites query anchors, reviews
evidence and preserves hard constraints. Read [query-planning.md](query-planning.md).
Verified relations require observed URLs and quotes; hypothetical names do not
count as discoveries. The code validates provenance, not factual truth.

Entity resolution, snowballing, omission audits and verifying primary pages
remain agent responsibilities. A failed source is not evidence of absence.

## Discover by capability

Rewrite the request as jobs and constraints:

- interface: web, mobile, CLI, API, IM, SSH, extension
- mechanism: wrapper, bridge, multiplexer, relay, gateway, native feature, protocol, managed service
- state: same process, same session, resumed state, imported history, monitoring only
- deployment: local, self-hosted, cloud, tunnel, public endpoint, private network

Search the capability × mechanism cells separately. Never submit the full research brief as one search query — a long query on AND-semantics engines returns little or nothing, and terms that appear in no target document (your own category vocabulary) actively suppress recall.

## Execute independent query families

Run short, single-intent queries across:

1. functional jobs and interfaces
2. category/taxonomy and alternatives
3. GitHub README/topics, packages, extensions, and app stores
4. community problem language and “what do you use” discussions
5. adjacent infrastructure that solves the job under different vocabulary
6. recent releases, changelogs, launch posts, and trending repositories

These are *routing* intents: they tell you which sites to search and what to look for, not words to append to the query. The runner encodes them as `DIMENSION_SITES`.

For a comprehensive claim, execute at least five brand-blind functional/taxonomy queries, three repository/package/app-store queries, three community queries, one recent-project query, and one adjacent-domain query per undercovered category.

Planning queries is not retrieval. Record actual queries, source planes, result URLs, canonical entities, and source failures in `DISCOVERY_LOG.md`. Model-prior suggestions do not count toward coverage until retrieved and verified.

## Resolve entities and combinations

For each unfamiliar user term or discovery, search exact, hyphenated, dehyphenated, spaced, edit-distance-1, acronym, transliteration, and local-language variants. Search co-occurrence and fixed phrases such as `"A" "B"`, `"A with B"`, `"A integration"`, and `"A plugin"`.

An LLM answer without a verified primary-source URL is unresolved.

## Snowball

For every HIGH/CRITICAL entity inspect official integrations, README outbound links, related projects, plugins, dependencies, reverse references, app-store developer pages, screenshot attribution, comparisons, migrations, and recommended stacks. Repeat once for newly discovered HIGH/CRITICAL entities.

## Keep discovery separate from evaluation

Build and deduplicate the entity catalog before ranking. Record whether each item was retrieved or merely suggested from model memory.

## Record source health

For every plane record timestamp, result count, relevant canonical entities, and CAPTCHA/403/429/5xx/timeout/no-source-synthesis failures. A failed source is not evidence of absence.

## Coverage and stopping gates

Semantic stop reasons are documented in query-planning.md. evidence_sufficient
means the planner reviewed evidence and marked gaps/constraints resolved with
healthy final retrieval. It does not prove completeness. query_budget and
rounds_exhausted mean the search was cut off; source_failure and needs_query_plan
need recovery or further agent work. Legacy entity/coverage saturation is only
a local diminishing-returns signal.

Do not claim “comprehensive”, “best”, or “full landscape” unless:

- every user-supplied unfamiliar name is resolved or explicitly unresolved
- every category has at least three candidates or is marked UNDERCOVERED
- every HIGH/CRITICAL entity has a verified primary source
- at least one discovery round used no user-supplied brand
- canonical entities came from at least three independent discovery paths
- an omission audit asked what solves the job using different category vocabulary
- the task's evidence and omission checks passed; no unresolved source/constraint gaps remain
- repository, official-ecosystem, and community sets show meaningful convergence

`family_coverage` compares the planner against its own plan and is near-1.0 by
construction — it is not evidence of recall. Cite `discovery.mined_entity_count`
and the per-round `new_entity_rate` instead.

Create `ENTITIES.md`, `DISCOVERY_LOG.md`, and `COVERAGE.md`. If any gate fails, label the report preliminary and continue discovery.

## Regression test known misses

When a user identifies a missed entity, save a brand-free version of the need and keep the missed canonical entity as a hidden expectation. Forward-test future revisions without exposing the answer. A revision is not fixed merely because it finds the entity after its name is added to the query.
