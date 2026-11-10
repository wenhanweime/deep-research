#!/usr/bin/env python3
"""Width planning and coverage metrics for the deep-research evidence pack.

The module deliberately has no network or model dependency.  Query-family
planning, diversity selection, and evaluation can therefore be tested with a
fixed corpus and reused by the live multi-source runner.
"""
from __future__ import annotations

import math
import re
from collections import Counter
from itertools import combinations
from typing import Iterable, Sequence


# --- Query budget -----------------------------------------------------------
#
# Search engines approximate AND semantics.  Every extra term shrinks recall,
# and a term that appears in no target document shrinks it to nothing.  The
# planner used to append its own taxonomy vocabulary ("candidate products and
# projects") to the user's brief; those words are not in any page we want, so
# they acted as pure negative signal.  Queries are now budgeted and scrubbed
# before they reach any plane.

MAX_QUERY_TERMS = 5

# Planner/methodology vocabulary. These describe *how we search*, never *what
# we are looking for*, so they must never reach an engine. Order matters:
# longer phrases are stripped first so their fragments do not survive.
STOPWORD_PHRASES = (
    "candidate products, projects, and organizations",
    "candidate products and projects",
    "category definitions and alternatives",
    "user jobs and operating workflows",
    "technical mechanisms and architecture",
    "user problems, recommendations, and failures",
    "user problems and recommendations",
    "repositories, packages, and extensions",
    "adjacent tools solving the same job",
    "adjacent domains solving the same job",
    "recent launches, releases, and changelogs",
    "recent releases and emerging projects",
    "limitations, failures, and risks",
    "regional and non-English vocabulary",
    "Chinese and non-English ecosystem terminology",
    "benchmarks, adoption, and comparative evidence",
    "benchmarks and comparative evidence",
    "what does not work and missing capabilities",
    "small and overlooked alternatives",
    "small and overlooked projects",
    "team, manager, and maintainer needs",
    "analogous dashboard and control-plane categories",
    "evolution of the category and prior approaches",
    "build versus buy and composable alternatives",
    "keyboard, voice, and low-friction access",
    "terminal, tmux, IDE, and automation integration",
    "multi-agent and session orchestration",
    "agent task and status workflows",
    "local, self-hosted, cloud, and remote deployment",
    "mobile and remote control workflows",
    "pricing, limits, and business model",
    "privacy, security, and operational risks",
    "taxonomy and capability searches",
    "cross-domain capability search",
)

# Single tokens that are pure scaffolding once the phrases above are removed.
STOPWORD_TERMS = frozenset(
    {
        "adjacent",
        "alternatives",
        "candidate",
        "community",
        "deployment",
        "evaluation",
        "failure",
        "integrations",
        "long-tail",
        "mechanisms",
        "products",
        "regional",
        "repositories",
        "risks",
        "stakeholders",
        "taxonomy",
        "workflows",
        # generic English glue that costs recall but carries no intent
        "and",
        "the",
        "for",
        "with",
        "that",
        "this",
        "from",
        "list",
        "sub",
    }
)

# A "significant term" is a quoted phrase, a Latin word (keeping RISC-V, gpt-4o,
# node.js intact), or a run of CJK characters.  CJK runs count as one term
# because a 4-character Chinese noun is one concept, not four.
_TERM_RE = re.compile(
    r'"[^"\n]+"'
    r"|'[^'\n]+'"
    r"|[A-Za-z][A-Za-z0-9_+#.\-/]*[A-Za-z0-9]"
    r"|[A-Za-z]"
    r"|[0-9][A-Za-z0-9_+#.\-/]*"
    r"|[㐀-鿿]+"
)


def significant_terms(text: str, merge: bool = True) -> list[str]:
    """Split text into engine-meaningful terms, dropping scaffolding words.

    Adjacent capitalized Latin words are merged by default so a multi-word
    proper noun counts as ONE term against the budget and is never cut in half
    ("Hong Guo Dongche Di" is one name, not four terms).
    """
    normalized = " ".join(str(text or "").split())
    terms: list[str] = []
    seen: set[str] = set()
    for raw in _TERM_RE.findall(normalized):
        term = raw.strip("\"'").strip()
        if not term:
            continue
        key = term.lower()
        if key in STOPWORD_TERMS or key in seen:
            continue
        seen.add(key)
        terms.append(term)
    return _merge_adjacent_anchors(terms) if merge else terms


def strip_methodology_vocab(text: str) -> str:
    """Remove planner phrases that never appear in a target document."""
    cleaned = " ".join(str(text or "").split())
    for phrase in sorted(STOPWORD_PHRASES, key=len, reverse=True):
        cleaned = re.sub(re.escape(phrase), " ", cleaned, flags=re.IGNORECASE)
    return " ".join(cleaned.split())


def enforce_query_budget(query: str, max_terms: int = MAX_QUERY_TERMS) -> str:
    """Scrub methodology vocabulary and cap a query at `max_terms` terms.

    Adjacent capitalized words are merged first so a multi-word proper noun is
    never cut in half ("Hong Guo Dongche Di" must not become "Hong").

    Raises ValueError rather than emitting an empty query: a silent empty
    search reads as "no results" and would be mistaken for evidence of absence.
    """
    if max_terms <= 0:
        raise ValueError("max_terms must be positive")
    stripped = strip_methodology_vocab(query)
    terms = significant_terms(stripped)
    if not terms:
        raise ValueError(f"query has no significant terms after scrubbing: {query!r}")
    return " ".join(terms[:max_terms])


# --- Term mining ------------------------------------------------------------
#
# The vocabulary for round N+1 must come from documents retrieved in round N,
# not from the planner's imagination.  Mining is deliberately deterministic
# (no network, no model) so the offline fixture comparison stays reproducible.

# Words that are frequent in SERP furniture but carry no research signal.
_MINING_NOISE = frozenset(
    {
        "http", "https", "www", "com", "org", "net", "html", "index", "page",
        "home", "search", "results", "result", "click", "read", "more", "here",
        "about", "how", "what", "why", "when", "where", "who", "which", "best",
        "top", "new", "using", "use", "used", "get", "make", "guide", "docs",
        "doc", "blog", "post", "posts", "news", "you", "your", "our", "their",
        "are", "was", "were", "has", "have", "had", "not", "but", "all", "can",
        "will", "would", "should", "may", "one", "two", "com.cn", "site",
        "介绍", "如何", "什么", "为什么", "怎么", "这个", "我们", "可以", "已经",
        "还是", "以及", "或者", "但是", "因为", "所以", "一个", "自己", "他们",
    }
)

_MINE_LATIN_RE = re.compile(r"[A-Za-z][A-Za-z0-9_+#.\-]*[A-Za-z0-9]|[A-Za-z]{2,}")
_MINE_CJK_RE = re.compile(r"[㐀-鿿]{2,}")

# Very common Chinese words that pass the "2+ CJK chars" shape test but carry
# no research signal.  Without this the miner expands on words like 免费/内容
# and the follow-up round searches noise instead of entities.
_CJK_GENERIC = frozenset(
    {
        "免费", "内容", "产品", "服务", "公司", "企业", "平台", "用户", "市场",
        "行业", "业务", "功能", "系统", "数据", "信息", "技术", "网络", "在线",
        "版本", "支持", "提供", "包括", "相关", "目前", "以及", "通过", "进行",
        "实现", "需要", "问题", "方式", "方法", "时间", "地址", "官方", "最新",
        "下载", "安装", "使用", "查看", "更多", "全部", "其他", "这些", "那些",
        "中国", "国内", "国际", "全球", "今年", "去年", "报道", "记者", "编辑",
        "视频", "文章", "评论", "分享", "关注", "推荐", "热门", "介绍", "详情",
        "不同", "优质", "重要", "主要", "基本", "特别", "非常", "已经", "可能",
        # common verbs/adjectives that survive the shape test but name nothing
        "海量", "推出", "体验", "免费看", "旗下", "涵盖", "打造", "致力", "覆盖",
        "上线", "发布", "更新", "开发", "运营", "合作", "投资", "收购", "成立",
        "亿元", "万元", "有限", "股份", "科技", "集团", "小说", "热门", "精彩",
        "随时", "随心", "一键", "追剧", "看剧", "观看", "播放", "剧集", "剧产品",
    }
)


def _latin_candidates(text: str) -> list[str]:
    """Proper-noun-ish Latin tokens: names, products, versioned identifiers."""
    out: list[str] = []
    for match in _MINE_LATIN_RE.findall(text or ""):
        if len(match) < 2 or match.lower() in _MINING_NOISE:
            continue
        # Capitalized, containing a digit, or internally punctuated
        # (RISC-V, gpt-4o, node.js), or all-caps.
        if match[0].isupper() or any(ch.isdigit() for ch in match) or any(ch in "-+#._" for ch in match[1:]):
            out.append(match)
    return out


def _cjk_word_boundaries(runs: Sequence[str], max_width: int = 4) -> set[str]:
    """Find CJK spans whose edges behave like real word boundaries.

    Chinese SERP text has no spaces, so slicing every 2-4 character window out
    of a run produces truncations ("的短剧" out of "喜爱的短剧").  Without a
    segmenter we use branching diversity: a real word appears with varied
    neighbours or at a run edge, while a fragment is pinned to one neighbour.

    Branching alone is not enough on a large corpus — a fragment accumulates
    varied neighbours too — so the result is further filtered by
    `_strip_particle_edges` and `_drop_substring_fragments`.
    """
    left: dict[str, set[str]] = {}
    right: dict[str, set[str]] = {}
    for run in runs:
        for width in range(2, max_width + 1):
            for i in range(len(run) - width + 1):
                span = run[i : i + width]
                left.setdefault(span, set()).add(run[i - 1] if i > 0 else "^")
                end = i + width
                right.setdefault(span, set()).add(run[end] if end < len(run) else "$")
    valid: set[str] = set()
    for span, left_neighbours in left.items():
        right_neighbours = right.get(span, set())
        left_ok = len(left_neighbours) >= 2 or "^" in left_neighbours
        right_ok = len(right_neighbours) >= 2 or "$" in right_neighbours
        if left_ok and right_ok:
            valid.add(span)
    return valid


# Grammatical particles and pronouns that can never begin or end a real entity
# name.  A span like "的短剧" is the word "短剧" with a possessive stuck on.
_CJK_EDGE_PARTICLES = "的了和与是在有个这那我你他她它们就都很也还把被对为从到及并或者上下中之以于用让给使能可会将"

# Chinese entity names are short. A longer unbroken run is a clause, and
# putting a clause into the next query is exactly the recall failure this
# whole change set exists to fix.
_CJK_MAX_TERM = 6


def _strip_particle_edges(span: str) -> str:
    """Trim grammatical glue from the edges of a CJK span.

    May return a string shorter than 2 characters; callers must re-check the
    minimum length so "的短" is discarded rather than kept as "短".
    """
    while span and span[0] in _CJK_EDGE_PARTICLES:
        span = span[1:]
    while span and span[-1] in _CJK_EDGE_PARTICLES:
        span = span[:-1]
    return span


def _mining_candidates(text: str, valid_cjk: set[str] | None = None) -> list[str]:
    """Extract proper-noun-ish candidates from one document's text."""
    out = _latin_candidates(text)
    for run in _MINE_CJK_RE.findall(text or ""):
        # A long unbroken CJK run is a SENTENCE, not a name. Chinese entity
        # names are short; taking the whole run would put a clause into the
        # next query, so only runs of entity length are used directly.
        if len(run) <= _CJK_MAX_TERM and run not in _CJK_GENERIC:
            stripped = _strip_particle_edges(run)
            if len(stripped) >= 2 and stripped not in _CJK_GENERIC:
                out.append(stripped)
        if len(run) > 4 and valid_cjk:
            for width in (2, 3, 4):
                for i in range(len(run) - width + 1):
                    span = _strip_particle_edges(run[i : i + width])
                    if len(span) < 2 or span in _MINING_NOISE or span in _CJK_GENERIC:
                        continue
                    if span in valid_cjk:
                        out.append(span)
    return out


def _drop_substring_fragments(rows: list[dict], *, dominance: float = 0.8) -> list[dict]:
    """Remove CJK fragments that are really a longer mined term.

    Sub-span generation is what lets a product name surface out of a compound
    phrase, but it also emits truncations ("质短剧" from "优质短剧").  A short
    span is kept only if it occurs substantially more often than every longer
    term containing it; otherwise its count is the longer term's occurrences
    counted a second time, and expanding on it wastes a query.
    """
    by_len = sorted(rows, key=lambda row: (-len(row["term"]), -row["doc_freq"]))
    kept: list[dict] = []
    for row in by_len:
        term = row["term"]
        if re.fullmatch(r"[㐀-鿿]+", term) and any(
            term in longer["term"]
            and term != longer["term"]
            and row["doc_freq"] <= longer["doc_freq"] / dominance
            for longer in kept
        ):
            continue
        kept.append(row)
    # Restore the caller's ranking; length order was only a filtering device.
    keep_keys = {row["term"] for row in kept}
    return [row for row in rows if row["term"] in keep_keys]


def mine_terms(
    items: Sequence[dict],
    seed_terms: Iterable[str] = (),
    *,
    limit: int = 20,
    min_doc_freq: int = 2,
) -> list[dict]:
    """Mine expansion vocabulary from retrieved documents.

    Returns rows of {term, freq, doc_freq, sample_url}. `sample_url` is a real
    document the term was observed in, so every round-N+1 query can be traced
    back to round-N evidence.
    """
    if not items:
        return []
    seed_lower = {str(term).lower() for term in seed_terms if term}
    freq: Counter[str] = Counter()
    doc_freq: Counter[str] = Counter()
    sample: dict[str, str] = {}
    display: dict[str, str] = {}

    texts = [
        " ".join(str(item.get(field) or "") for field in ("title", "snippet"))
        for item in items
    ]
    # Word boundaries are a property of the whole corpus, not one document:
    # a span is a word if it appears with varied neighbours across everything
    # retrieved this round. Compute once, then reuse per document.
    all_runs = [run for text in texts for run in _MINE_CJK_RE.findall(text)]
    valid_cjk = _cjk_word_boundaries(all_runs)

    for item, text in zip(items, texts):
        url = str(item.get("url") or "")
        in_this_doc: set[str] = set()
        for candidate in _mining_candidates(text, valid_cjk):
            key = candidate.lower()
            if key in seed_lower or key in _MINING_NOISE or key in STOPWORD_TERMS or key in _CJK_GENERIC:
                continue
            if any(key in seed for seed in seed_lower) or any(seed in key for seed in seed_lower):
                continue
            freq[key] += 1
            display.setdefault(key, candidate)
            if key not in in_this_doc:
                in_this_doc.add(key)
                doc_freq[key] += 1
                if url:
                    sample.setdefault(key, url)

    rows = [
        {
            "term": display[key],
            "freq": freq[key],
            "doc_freq": doc_freq[key],
            "sample_url": sample.get(key, ""),
        }
        for key in freq
        if doc_freq[key] >= min_doc_freq and sample.get(key)
    ]
    # Rank by document spread first (a term in many documents is a real topic
    # term, not one page's idiosyncrasy), then raw frequency, then stable name.
    rows.sort(key=lambda row: (-row["doc_freq"], -row["freq"], row["term"].lower()))
    return _drop_substring_fragments(rows)[:limit]


# Dimension -> browser sites. The taxonomy now steers *where* we look instead
# of being concatenated into the query text, which is where it used to destroy
# recall. Empty tuple means "use the run's configured default sites".
DIMENSION_SITES = {
    "community": ("reddit", "x", "google"),
    "regional": ("sogou-weixin", "google"),
    "repository": ("google",),
    "long-tail": ("google",),
    "recent": ("x", "google"),
    "mobile": ("google",),
    "pricing": ("google",),
}


def sites_for_dimension(dimension: str, default_sites: str) -> str:
    """Route a family to the sites that actually carry its kind of evidence."""
    sites = DIMENSION_SITES.get(str(dimension or "").lower())
    if not sites:
        return default_sites
    allowed = {s.strip() for s in default_sites.split(",") if s.strip()}
    picked = [s for s in sites if s in allowed]
    return ",".join(picked) if picked else default_sites


WIDTH_PROFILES = {
    "legacy": {"candidate_queries": 1, "selected_queries": 1, "max_similarity": 1.0},
    "narrow": {"candidate_queries": 8, "selected_queries": 2, "max_similarity": 0.72},
    "standard": {"candidate_queries": 12, "selected_queries": 4, "max_similarity": 0.68},
    "wide": {"candidate_queries": 16, "selected_queries": 6, "max_similarity": 0.65},
    "deep-wide": {"candidate_queries": 20, "selected_queries": 8, "max_similarity": 0.65},
}


def normalize_width(width: str | None) -> str:
    """Return a supported width profile, accepting breadth as a friendly alias."""
    value = (width or "legacy").strip().lower().replace("_", "-")
    if value in {"breadth", "broad", "full"}:
        value = "wide"
    if value not in WIDTH_PROFILES:
        raise ValueError(f"unsupported width profile: {width!r}")
    return value


def _tokens(text: str) -> set[str]:
    """Tokenize English and Chinese without requiring jieba or embeddings."""
    normalized = " ".join(str(text or "").lower().split())
    words = set(re.findall(r"[\w]+", normalized, flags=re.UNICODE))
    cjk = "".join(re.findall(r"[\u3400-\u9fff]", normalized))
    words.update(cjk[i : i + 2] for i in range(max(0, len(cjk) - 1)))
    if cjk:
        words.update(cjk)
    return {token for token in words if token}


def query_similarity(left: str, right: str) -> float:
    """Jaccard similarity used as a deterministic, dependency-free MMR proxy."""
    a, b = _tokens(left), _tokens(right)
    if not a and not b:
        return 1.0
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def _family(family_id: str, query: str, dimension: str, topic: str, perspective: str, source_strategy: str, rank: int, *, entity_focus: Sequence[str] = (), dimension_label: str = "", provenance: dict | None = None) -> dict:
    return {
        "family_id": family_id,
        "query": query,
        "dimension": dimension,
        "topic": topic,
        "perspective": perspective,
        "source_strategy": source_strategy,
        "entity_focus": list(entity_focus),
        "dimension_label": dimension_label or "",
        "provenance": dict(provenance or {}),
        "rank": rank,
    }


# --- Probe planning ---------------------------------------------------------
#
# Round 0 must be SHORT and must use only the user's own vocabulary.  We never
# invent topic words here: anything not present in the brief cannot be assumed
# to appear in a target document.  Breadth in round 0 comes from splitting the
# brief into several 2-3 term probes, not from lengthening one query.

_ANCHOR_LATIN_RE = re.compile(r"^[A-Z0-9]")


def _is_anchor(term: str) -> bool:
    """Proper-noun-ish terms: names, products, CJK nouns, versioned tokens."""
    if not term:
        return False
    if re.match(r"^[㐀-鿿]", term):
        return True
    if any(ch.isdigit() for ch in term):
        return True
    if any(ch in "-+#._/" for ch in term[1:]):
        return True
    return bool(_ANCHOR_LATIN_RE.match(term))


def _merge_adjacent_anchors(terms: Sequence[str]) -> list[str]:
    """Join runs of capitalized Latin tokens: Hong Guo Dongche Di -> one name."""
    merged: list[str] = []
    buffer: list[str] = []
    for term in terms:
        latin_cap = bool(re.match(r"^[A-Z][a-z]+$", term))
        if latin_cap:
            buffer.append(term)
            continue
        if buffer:
            merged.append(" ".join(buffer) if len(buffer) > 1 else buffer[0])
            buffer = []
        merged.append(term)
    if buffer:
        merged.append(" ".join(buffer) if len(buffer) > 1 else buffer[0])
    return merged


def plan_probe_queries(query: str, max_probes: int = 3, terms_per_probe: int = 3) -> list[str]:
    """Split a research brief into short, single-intent probe queries.

    Uses only vocabulary the user supplied.  Returns 1..max_probes queries of
    at most `terms_per_probe` terms each.
    """
    terms = significant_terms(strip_methodology_vocab(query))
    if not terms:
        raise ValueError(f"query has no significant terms: {query!r}")
    anchors = [term for term in terms if _is_anchor(term)]
    context = [term for term in terms if not _is_anchor(term)]

    probes: list[str] = []
    seen: set[str] = set()

    def add(parts: Sequence[str]) -> None:
        candidate = " ".join(dict.fromkeys(p for p in parts if p))[:200].strip()
        if not candidate:
            return
        key = candidate.lower()
        if key in seen:
            return
        seen.add(key)
        probes.append(candidate)

    if anchors:
        primary = anchors[0]
        # Pair the primary entity with each other entity: short and specific.
        for other in anchors[1:]:
            add([primary, other][:terms_per_probe])
        # One probe grounding the primary entity in the user's context words.
        if context:
            add([primary, *context[: terms_per_probe - 1]])
        if not probes:
            add([primary, *context[: terms_per_probe - 1]] if context else [primary])
    else:
        for start in range(0, len(terms), terms_per_probe):
            add(terms[start : start + terms_per_probe])

    return probes[: max(1, max_probes)]


def plan_expansion_queries(
    seed_query: str,
    mined: Sequence[dict],
    *,
    max_queries: int = 4,
    terms_per_query: int = 3,
) -> list[dict]:
    """Build round-N+1 queries from terms mined out of round-N documents.

    Every returned query carries provenance back to the document its new term
    came from, so "did this query come from evidence?" is answerable.
    """
    anchors = significant_terms(strip_methodology_vocab(seed_query))
    anchor = next((term for term in anchors if _is_anchor(term)), anchors[0] if anchors else "")
    out: list[dict] = []
    seen: set[str] = set()
    for row in mined:
        if len(out) >= max_queries:
            break
        term = str(row.get("term") or "").strip()
        if not term:
            continue
        parts = [part for part in (anchor, term) if part][:terms_per_query]
        query = " ".join(dict.fromkeys(parts))
        key = query.lower()
        if not query or key in seen:
            continue
        seen.add(key)
        out.append(
            {
                "query": query,
                "provenance": {
                    "term": term,
                    "source_url": row.get("sample_url", ""),
                    "doc_freq": row.get("doc_freq", 0),
                },
            }
        )
    return out


def generate_query_families(query: str, width: str = "legacy", depth: str = "standard") -> list[dict]:
    """Generate short, single-intent probe families for a research goal.

    The dimension table below is a *routing* plan, not query text.  Each family
    decides which planes/source types to emphasize; the query itself stays in
    the user's own vocabulary and within the term budget.  Appending taxonomy
    words like "candidate products and projects" to the query used to collapse
    recall on AND-semantics engines, because no target page contains them.
    """
    profile = normalize_width(width)
    clean = " ".join(query.split())
    if not clean:
        raise ValueError("query must not be empty")
    if profile == "legacy":
        return [
            _family(
                "q00-seed",
                enforce_query_budget(clean),
                "seed",
                "user question",
                "neutral",
                "all configured planes",
                0,
            )
        ]

    is_vibe_board = any(term in clean.lower() for term in ("vibecoding", "vibe coding", "看板", "kanban"))
    if is_vibe_board:
        specs = [
            ("entity", "candidate products and projects", "neutral", "repositories, official pages", "products"),
            ("workflow", "agent task and status workflows", "developer", "docs, demos, implementation pages", "workflows"),
            ("orchestration", "multi-agent and session orchestration", "operator", "GitHub, architecture docs", "orchestration"),
            ("integration", "terminal, tmux, IDE, and automation integration", "developer", "official integrations, packages", "integrations"),
            ("community", "user problems, recommendations, and failures", "user", "Reddit, X, forums", "community"),
            ("adjacent", "adjacent tools solving the same job", "alternative vendor", "category and capability searches", "adjacent"),
            ("recent", "recent launches, releases, and changelogs", "market observer", "recent projects and release notes", "recent"),
            ("deployment", "local, self-hosted, cloud, and remote deployment", "operator", "docs, pricing, deployment guides", "deployment"),
            ("mobile", "mobile and remote control workflows", "remote user", "mobile apps, SSH, browser control", "mobile"),
            ("pricing", "pricing, limits, and business model", "buyer", "pricing pages and comparisons", "pricing"),
            ("risk", "privacy, security, and operational risks", "security reviewer", "security docs, issues, audits", "risk"),
            ("regional", "Chinese and non-English ecosystem terminology", "regional user", "中文社区 and regional sources", "regional"),
            ("evaluation", "benchmarks, adoption, and comparative evidence", "researcher", "papers, benchmarks, case studies", "evaluation"),
            ("failure", "what does not work and missing capabilities", "skeptical user", "issues, postmortems, complaints", "failure"),
            ("long-tail", "small and overlooked projects", "independent builder", "GitHub topics, package indexes", "long-tail"),
            ("stakeholders", "team, manager, and maintainer needs", "team manager", "team workflows and maintainer docs", "stakeholders"),
            ("cross-domain", "analogous dashboard and control-plane categories", "adjacent researcher", "cross-domain capability search", "cross-domain"),
            ("history", "evolution of the category and prior approaches", "historian", "archives, changelogs, older projects", "history"),
            ("alternatives", "build versus buy and composable alternatives", "architect", "technical comparisons and examples", "alternatives"),
            ("accessibility", "keyboard, voice, and low-friction access", "power user", "workflow docs and user reports", "accessibility"),
        ]
    else:
        specs = [
            ("entity", "candidate products, projects, and organizations", "neutral", "official pages and repositories", "products"),
            ("taxonomy", "category definitions and alternatives", "researcher", "taxonomy and capability searches", "taxonomy"),
            ("workflow", "user jobs and operating workflows", "user", "docs, tutorials, case studies", "workflows"),
            ("mechanism", "technical mechanisms and architecture", "engineer", "papers, READMEs, architecture docs", "mechanisms"),
            ("community", "user problems and recommendations", "user", "forums, Reddit, social", "community"),
            ("repository", "repositories, packages, and extensions", "builder", "GitHub and package indexes", "repositories"),
            ("adjacent", "adjacent domains solving the same job", "alternative vendor", "cross-domain searches", "adjacent"),
            ("recent", "recent releases and emerging projects", "market observer", "changelogs and launch posts", "recent"),
            ("risk", "limitations, failures, and risks", "skeptic", "issues, audits, failure reports", "risks"),
            ("regional", "regional and non-English vocabulary", "regional user", "local-language sources", "regional"),
            ("evaluation", "benchmarks and comparative evidence", "researcher", "papers and evaluations", "evaluation"),
            ("long-tail", "small and overlooked alternatives", "independent builder", "topic and package searches", "long-tail"),
        ]

    # Round-0 queries come from splitting the user's brief, never from the
    # taxonomy.  Probes are cycled across families so each family searches a
    # short query while still recording its own routing intent.
    probes = plan_probe_queries(clean, max_probes=max(3, WIDTH_PROFILES[profile]["selected_queries"]))
    families = []
    for idx, (dimension, topic, perspective, source_strategy, label) in enumerate(specs):
        family_query = probes[idx % len(probes)]
        families.append(
            _family(
                f"q{idx + 1:02d}-{dimension}",
                family_query,
                dimension,
                topic,
                perspective,
                source_strategy,
                idx + 1,
                dimension_label=label,
            )
        )
    return families[: WIDTH_PROFILES[profile]["candidate_queries"]]


def select_diverse_query_families(families: Sequence[dict], max_selected: int, max_similarity: float = 0.65) -> list[dict]:
    """Select query families that differ in *routing*, not just in wording.

    Round-0 queries are intentionally short and reuse the user's vocabulary, so
    they overlap lexically by design.  Redundancy therefore means running the
    same query against the same dimension; families are also spread evenly
    across the available probes before any probe is reused.
    """
    if max_selected <= 0:
        return []
    selected: list[dict] = []
    used_queries: Counter[str] = Counter()
    for candidate in sorted(families, key=lambda item: (item.get("rank", 0), item.get("family_id", ""))):
        if len(selected) >= max_selected:
            break
        query = str(candidate.get("query", "")).lower()
        if used_queries and used_queries[query] > min(used_queries.values()):
            continue
        if any(
            query_similarity(candidate.get("query", ""), chosen.get("query", "")) > max_similarity
            and candidate.get("dimension") == chosen.get("dimension")
            for chosen in selected
        ):
            continue
        selected.append(dict(candidate))
        used_queries[query] += 1
    # A strict threshold can leave a profile underfilled. Fill deterministically
    # while preserving the diversity signal in the selected set.
    if len(selected) < max_selected:
        for candidate in families:
            if len(selected) >= max_selected:
                break
            if candidate.get("family_id") not in {item.get("family_id") for item in selected}:
                selected.append(dict(candidate))
    return selected


def build_research_profile(width: str, depth: str, *, max_queries: int | None = None, rounds: int = 2) -> dict:
    profile = normalize_width(width)
    config = WIDTH_PROFILES[profile]
    selected = config["selected_queries"]
    if max_queries is not None:
        selected = min(selected, max(1, int(max_queries)))
    max_branch_depth = 1 if depth == "fast" else 2 if depth == "standard" else 3
    max_branch_depth = max(1, min(int(rounds or 1), max_branch_depth)) if rounds else max_branch_depth
    # The total query budget must cover every planned round, otherwise the
    # loop would trip the budget gate before it ever expands.
    total_query_budget = max_queries if max_queries is not None else selected * max_branch_depth
    return {
        "mode": profile,
        "width": {
            "profile": profile,
            "candidate_queries": config["candidate_queries"],
            "selected_queries": selected,
            "max_seed_similarity": config["max_similarity"],
            "target_dimensions": ["entity", "topic", "perspective", "source", "geography", "time"],
        },
        "depth": {"profile": depth, "max_branch_depth": max_branch_depth},
        "stopping": {
            "max_queries": total_query_budget,
            "two_round_new_entity_rate_below": 0.10,
            "two_round_new_coverage_rate_below": 0.08,
            "max_branch_overlap": 0.70,
        },
    }


def annotate_items(items: Iterable[dict], family: dict) -> list[dict]:
    """Attach query-family metadata without discarding source-specific fields.

    `entities` is deliberately NOT seeded from the planner's own label: doing so
    made coverage.entities echo the taxonomy (products/taxonomy/workflows...)
    regardless of what was actually retrieved, so a run that discovered nothing
    still reported a healthy entity count. Planner vocabulary lives in
    `dimension_label`; `entities` is reserved for terms mined from documents.
    """
    annotated = []
    for item in items:
        row = dict(item)
        row["family_id"] = family.get("family_id")
        row["family_ids"] = [family.get("family_id")] if family.get("family_id") else []
        row["family_query"] = family.get("query")
        row["dimension"] = family.get("dimension")
        row["dimension_label"] = family.get("dimension_label") or family.get("entity_focus") or ""
        row["topic"] = family.get("topic")
        row["perspective"] = family.get("perspective")
        row["source_strategy"] = family.get("source_strategy")
        if family.get("provenance"):
            row["query_provenance"] = family["provenance"]
        if family.get("round") is not None:
            row["round"] = family["round"]
        row.setdefault("entities", [])
        row.setdefault("topics", [family.get("topic")] if family.get("topic") else [])
        row.setdefault("perspectives", [family.get("perspective")] if family.get("perspective") else [])
        annotated.append(row)
    return annotated


def _field_values(item: dict, names: Sequence[str]) -> set[str]:
    values: set[str] = set()
    for name in names:
        value = item.get(name)
        if isinstance(value, str):
            values.add(value)
        elif isinstance(value, (list, tuple, set)):
            values.update(str(v) for v in value if v)
    return {v for v in values if v}


def _entropy(values: Iterable[str]) -> float:
    counts = Counter(v for v in values if v)
    total = sum(counts.values())
    if total <= 1 or len(counts) <= 1:
        return 0.0
    raw = -sum((count / total) * math.log(count / total) for count in counts.values())
    return raw / math.log(len(counts))


def coverage_metrics(items: Sequence[dict], families: Sequence[dict] = (), seed_entities: Iterable[str] = ()) -> dict:
    """Compute width metrics from normalized evidence or a labelled fixture."""
    unique_urls = {str(item.get("url", "")).split("#", 1)[0].rstrip("/") for item in items if item.get("url")}
    family_ids: set[str] = set()
    for item in items:
        family_ids.update(str(value) for value in item.get("family_ids", []) if value)
        if item.get("family_id"):
            family_ids.add(str(item["family_id"]))
    planned_ids = {family.get("family_id") for family in families if family.get("family_id")}
    topics = set().union(*(_field_values(item, ("topics", "topic")) for item in items)) if items else set()
    entities = set().union(*(_field_values(item, ("entities", "entity")) for item in items)) if items else set()
    perspectives = set().union(*(_field_values(item, ("perspectives", "perspective")) for item in items)) if items else set()
    source_types = []
    domains = []
    for item in items:
        planes = item.get("planes") or [item.get("plane") or item.get("source") or "unknown"]
        source_types.extend(str(plane).split(":", 1)[0] for plane in planes)
        url = str(item.get("url") or "")
        match = re.match(r"https?://([^/]+)", url)
        if match:
            domains.append(match.group(1).lower().removeprefix("www."))

    by_family: dict[str, set[str]] = {}
    for item in items:
        item_families = list(item.get("family_ids") or [])
        if item.get("family_id") and item.get("family_id") not in item_families:
            item_families.append(item.get("family_id"))
        if not item_families:
            item_families = ["unassigned"]
        if item.get("url"):
            for fid in item_families:
                by_family.setdefault(str(fid), set()).add(str(item["url"]).split("#", 1)[0].rstrip("/"))
    overlaps = [len(a & b) / len(a | b) for a, b in combinations(by_family.values(), 2) if a | b]
    seed = {str(value) for value in seed_entities if value}
    novel_entities = entities - seed
    family_coverage = len(family_ids & planned_ids) / len(planned_ids) if planned_ids else (1.0 if family_ids else 0.0)
    dimension_by_family = {
        str(family.get("family_id")): family.get("dimension")
        for family in families
        if family.get("family_id") and family.get("dimension")
    }
    dimension_count = len(set(dimension_by_family.values()))
    dimensions_hit: set[str] = set()
    for item in items:
        if item.get("dimension"):
            dimensions_hit.add(str(item["dimension"]))
        for family_id in item.get("family_ids", []) or []:
            if str(family_id) in dimension_by_family:
                dimensions_hit.add(str(dimension_by_family[str(family_id)]))
        if item.get("family_id") and str(item["family_id"]) in dimension_by_family:
            dimensions_hit.add(str(dimension_by_family[str(item["family_id"])]))
    return {
        "unique_urls": len(unique_urls),
        "items": len(items),
        "query_families_hit": len(family_ids),
        "query_families_planned": len(planned_ids),
        "family_coverage": round(family_coverage, 4),
        "topics": sorted(topics),
        "topic_count": len(topics),
        "entities": sorted(entities),
        "entity_count": len(entities),
        "novel_entities": sorted(novel_entities),
        "novel_entity_count": len(novel_entities),
        "perspectives": sorted(perspectives),
        "perspective_count": len(perspectives),
        "source_types": sorted(set(source_types)),
        "source_type_count": len(set(source_types)),
        "domain_count": len(set(domains)),
        "source_type_entropy": round(_entropy(source_types), 4),
        "domain_entropy": round(_entropy(domains), 4),
        # One query path cannot demonstrate path diversity.  Scale the
        # non-overlap score by the number of independent paths so the legacy
        # baseline is 0 rather than being mistaken for a perfectly diverse run.
        "path_diversity": round(
            (1 - (sum(overlaps) / len(overlaps) if overlaps else 0.0))
            * min(1.0, max(0, len(by_family) - 1) / 3),
            4,
        ),
        "trajectory_overlap": round(sum(overlaps) / len(overlaps) if overlaps else 0.0, 4),
        "dimensions_hit": len(dimensions_hit),
        "dimensions_planned": dimension_count,
        "aspect_coverage": round(len(dimensions_hit) / dimension_count, 4) if dimension_count else 0.0,
    }


def profile_families(query: str, width: str, depth: str = "standard", max_queries: int | None = None, rounds: int = 2) -> tuple[dict, list[dict], list[dict]]:
    """Return (profile, candidates, selected) for live runners and tests."""
    profile = build_research_profile(width, depth, max_queries=max_queries, rounds=rounds)
    candidates = generate_query_families(query, width, depth)
    selected = select_diverse_query_families(
        candidates,
        profile["width"]["selected_queries"],
        profile["width"]["max_seed_similarity"],
    )
    return profile, candidates, selected


def should_stop(rounds: Sequence[dict], profile: dict, *, queries_used: int) -> tuple[bool, str]:
    """Decide whether the progressive loop has converged.

    This reads the `stopping` block of the research profile, which previously
    existed in the manifest but was never consulted by any control flow.
    """
    stopping = (profile or {}).get("stopping", {}) or {}
    max_queries = int(stopping.get("max_queries") or 0)
    if max_queries and queries_used >= max_queries:
        return True, "query_budget"

    if not rounds:
        return False, ""
    if not rounds[-1].get("queries"):
        return True, "no_new_queries"

    # Convergence is checked before the depth ceiling so the manifest records
    # *why* the loop really ended: "we stopped learning" is a different signal
    # from "we ran out of allowed rounds".
    entity_floor = float(stopping.get("two_round_new_entity_rate_below") or 0)
    if entity_floor and len(rounds) >= 2:
        recent = rounds[-2:]
        if all(row.get("new_entity_rate", 1.0) < entity_floor for row in recent):
            return True, "entity_saturation"

    coverage_floor = float(stopping.get("two_round_new_coverage_rate_below") or 0)
    if coverage_floor and len(rounds) >= 2:
        recent = rounds[-2:]
        if all(row.get("new_url_rate", 1.0) < coverage_floor for row in recent):
            return True, "coverage_saturation"

    max_depth = int(((profile or {}).get("depth") or {}).get("max_branch_depth") or 0)
    if max_depth and len(rounds) >= max_depth:
        return True, "max_branch_depth"

    return False, ""
