import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parents[1] / "scripts"
FIXTURE = Path(__file__).resolve().parent / "fixtures/vibecoding_dashboard_corpus.jsonl"
sys.path.insert(0, str(SCRIPT_DIR))

from breadth import (  # noqa: E402
    MAX_QUERY_TERMS,
    STOPWORD_PHRASES,
    annotate_items,
    coverage_metrics,
    enforce_query_budget,
    generate_query_families,
    mine_terms,
    plan_expansion_queries,
    plan_probe_queries,
    profile_families,
    query_similarity,
    select_diverse_query_families,
    should_stop,
    significant_terms,
    sites_for_dimension,
)
from progressive import run_progressive  # noqa: E402
from evaluate_breadth import compare, load_fixture  # noqa: E402


class QueryBudgetTests(unittest.TestCase):
    """A long query is a recall bug: engines approximate AND semantics."""

    LONG_BRIEF = (
        "ByteDance departments list 红果短剧 懂车帝 Hong Guo Dongche Di org chart "
        "sub departments category definitions and alternatives taxonomy"
    )

    def test_budget_caps_terms_and_strips_methodology_vocab(self):
        result = enforce_query_budget(self.LONG_BRIEF)
        self.assertLessEqual(len(significant_terms(result)), MAX_QUERY_TERMS)
        for banned in ("category definitions", "alternatives", "taxonomy"):
            self.assertNotIn(banned, result.lower())

    def test_empty_after_scrubbing_raises_instead_of_searching_nothing(self):
        with self.assertRaises(ValueError):
            enforce_query_budget("candidate products and projects")

    def test_no_generated_query_contains_methodology_vocab(self):
        """The planner's taxonomy must never reach a search engine."""
        for brief in ("vibecoding 管理看板类产品", "RISC-V 数据中心", self.LONG_BRIEF):
            for width in ("legacy", "narrow", "standard", "wide", "deep-wide"):
                for family in generate_query_families(brief, width, "standard"):
                    lowered = family["query"].lower()
                    for phrase in STOPWORD_PHRASES:
                        self.assertNotIn(phrase.lower(), lowered, f"{width}/{brief}")
                    self.assertLessEqual(
                        len(significant_terms(family["query"])),
                        MAX_QUERY_TERMS,
                        f"{width}/{brief}: {family['query']!r}",
                    )

    def test_probes_use_only_user_vocabulary(self):
        brief = "腾讯 WorkBuddy 生态高级产品经理 深圳 面试"
        allowed = set(significant_terms(brief))
        for probe in plan_probe_queries(brief):
            for term in significant_terms(probe):
                self.assertTrue(
                    any(term in word or word in term for word in allowed),
                    f"probe invented vocabulary: {term!r}",
                )

    def test_multi_word_proper_noun_survives_budgeting(self):
        result = enforce_query_budget("ByteDance 红果短剧 Hong Guo Dongche Di")
        self.assertIn("Hong Guo Dongche Di", result)


class MineTermsTests(unittest.TestCase):
    ITEMS = [
        {"url": "https://a.test/1", "title": "红果短剧 Nuggets Drama", "snippet": "抖音集团 旗下 红果短剧"},
        {"url": "https://a.test/2", "title": "Nuggets growth", "snippet": "抖音集团 Nuggets DAU"},
        {"url": "https://b.test/1", "title": "懂车帝 Dongchedi", "snippet": "抖音集团 懂车帝"},
    ]

    def test_mined_terms_carry_provenance_to_a_real_document(self):
        urls = {item["url"] for item in self.ITEMS}
        for row in mine_terms(self.ITEMS, seed_terms=["bytedance"]):
            self.assertIn(row["sample_url"], urls)
            self.assertGreaterEqual(row["doc_freq"], 2)

    def test_seed_terms_are_not_re_mined(self):
        terms = {row["term"].lower() for row in mine_terms(self.ITEMS, seed_terms=["nuggets"])}
        self.assertNotIn("nuggets", terms)

    def test_mines_cjk_and_latin_proper_nouns(self):
        terms = {row["term"] for row in mine_terms(self.ITEMS, seed_terms=[])}
        self.assertIn("抖音集团", terms)
        self.assertIn("Nuggets", terms)

    def test_empty_corpus_is_safe(self):
        self.assertEqual(mine_terms([], seed_terms=["x"]), [])

    def test_truncated_cjk_fragments_are_dropped(self):
        """Regression from a live run: sub-span mining emitted 字节跳/的短剧.

        Sub-spans are what let a product name surface out of a compound phrase,
        but Chinese SERP text has no spaces, so naive slicing cuts across word
        boundaries and the follow-up round then searches a truncation.
        """
        items = [
            {"url": "https://a/1", "title": "字节跳动 架构", "snippet": "个性化推荐找到你爱的短剧"},
            {"url": "https://a/2", "title": "字节跳动 业务", "snippet": "喜爱的短剧一键追剧"},
            {"url": "https://a/3", "title": "字节跳动 财报", "snippet": "致力于为用户提供优质短剧"},
        ]
        terms = {row["term"] for row in mine_terms(items, seed_terms=[])}
        self.assertIn("字节跳动", terms)
        for fragment in ("字节跳", "节跳动", "的短剧", "的短", "质短剧"):
            self.assertNotIn(fragment, terms)

    def test_long_cjk_run_is_not_mined_as_one_term(self):
        """A clause is not a name; putting one in the next query is the bug."""
        clause = "致力于为用户提供海量免费优质短剧内容的平台"
        items = [
            {"url": f"https://a/{i}", "title": clause, "snippet": clause}
            for i in range(3)
        ]
        for row in mine_terms(items, seed_terms=[]):
            self.assertLessEqual(len(row["term"]), 6, row["term"])

    def test_generic_chinese_words_are_not_mined(self):
        """Regression: the loop expanded on 免费/内容 instead of entities."""
        items = [
            {"url": "https://a/1", "title": "红果短剧 免费 内容", "snippet": "产品 服务 平台 用户"},
            {"url": "https://a/2", "title": "红果短剧 免费 内容", "snippet": "产品 服务 平台 市场"},
        ]
        terms = {row["term"] for row in mine_terms(items, seed_terms=[])}
        self.assertIn("红果短剧", terms)
        for noise in ("免费", "内容", "产品", "服务", "平台", "用户", "海量", "推出"):
            self.assertNotIn(noise, terms)

    def test_ranking_survives_fragment_filtering(self):
        items = [
            {"url": f"https://a/{i}", "title": "字节跳动 火山引擎", "snippet": "字节跳动"}
            for i in range(3)
        ]
        rows = mine_terms(items, seed_terms=[])
        self.assertEqual([row["doc_freq"] for row in rows], sorted((r["doc_freq"] for r in rows), reverse=True))

    def test_expansion_queries_carry_provenance(self):
        mined = mine_terms(self.ITEMS, seed_terms=["bytedance"])
        for row in plan_expansion_queries("ByteDance org chart", mined):
            self.assertTrue(row["provenance"]["source_url"])
            self.assertIn(row["provenance"]["term"], row["query"])


class ProgressiveLoopTests(unittest.TestCase):
    CORPUS = {
        "ByteDance 红果短剧": [
            {"url": "https://a.test/1", "title": "红果短剧 Nuggets", "snippet": "抖音集团 红果短剧"},
            {"url": "https://a.test/2", "title": "Nuggets growth", "snippet": "抖音集团 Nuggets"},
        ],
        "ByteDance 懂车帝": [
            {"url": "https://b.test/1", "title": "懂车帝 Dongchedi", "snippet": "抖音集团 懂车帝"},
        ],
        "ByteDance 抖音集团": [
            {"url": "https://c.test/1", "title": "抖音集团 org", "snippet": "抖音集团 火山引擎"},
            {"url": "https://c.test/2", "title": "抖音集团 units", "snippet": "抖音集团 火山引擎"},
        ],
    }
    BRIEF = "ByteDance departments list 红果短剧 懂车帝 org chart"

    def _search(self, families):
        out = []
        for family in families:
            items = [
                dict(item, plane="smart-search:search")
                for item in self.CORPUS.get(family["query"], [])
            ]
            out.append((items, {"family_id": family["family_id"], "query": family["query"], "hits": len(items)}))
        return out

    def test_round_one_queries_come_from_round_zero_results(self):
        profile, _, selected = profile_families(self.BRIEF, "standard", "standard", rounds=2)
        result = run_progressive(self.BRIEF, selected, profile, self._search, rounds=2)
        self.assertGreaterEqual(len(result["rounds"]), 2)

        round_zero_text = " ".join(
            f"{item.get('title', '')} {item.get('snippet', '')}"
            for query in result["rounds"][0]["queries"]
            for item in self.CORPUS.get(query, [])
        )
        seed_vocab = {term.lower() for term in significant_terms(self.BRIEF)}
        expansions = [run for run in result["family_runs"] if run.get("provenance")]
        self.assertTrue(expansions, "no expansion queries were generated")
        # At least one round-1 query must use a term that appeared in round-0
        # documents but was absent from the seed brief.
        self.assertTrue(
            any(
                run["provenance"]["term"] in round_zero_text
                and run["provenance"]["term"].lower() not in seed_vocab
                for run in expansions
            )
        )

    def test_every_expansion_traces_to_a_retrieved_document(self):
        profile, _, selected = profile_families(self.BRIEF, "standard", "standard", rounds=2)
        result = run_progressive(self.BRIEF, selected, profile, self._search, rounds=2)
        retrieved = {item["url"] for item in result["items"]}
        for run in result["family_runs"]:
            if run.get("provenance"):
                self.assertIn(run["provenance"]["source_url"], retrieved)

    def test_single_round_is_backwards_compatible(self):
        profile, _, selected = profile_families(self.BRIEF, "standard", "standard", rounds=1)
        result = run_progressive(self.BRIEF, selected, profile, self._search, rounds=1)
        self.assertEqual(len(result["rounds"]), 1)
        self.assertFalse([run for run in result["family_runs"] if run.get("provenance")])

    def test_batch_failure_does_not_kill_the_loop(self):
        def boom(_families):
            raise RuntimeError("plane down")

        profile, _, selected = profile_families(self.BRIEF, "standard", "standard", rounds=2)
        result = run_progressive(self.BRIEF, selected, profile, boom, rounds=2)
        self.assertTrue(result["stop_reason"])


class StoppingGateTests(unittest.TestCase):
    """These knobs existed in the manifest but no code ever read them."""

    def setUp(self):
        self.profile = profile_families("a b c", "standard", "standard", rounds=3)[0]

    def test_query_budget_stops_the_loop(self):
        rounds = [{"queries": ["q"], "new_entity_rate": 0.9, "new_url_rate": 0.9}]
        self.assertEqual(
            should_stop(rounds, self.profile, queries_used=999),
            (True, "query_budget"),
        )

    def test_entity_saturation_stops_the_loop(self):
        rounds = [{"queries": ["q"], "new_entity_rate": 0.01, "new_url_rate": 0.5}] * 2
        stop, reason = should_stop(rounds, self.profile, queries_used=1)
        self.assertTrue(stop)
        self.assertEqual(reason, "entity_saturation")

    def test_healthy_round_continues(self):
        rounds = [{"queries": ["q"], "new_entity_rate": 0.9, "new_url_rate": 0.9}]
        self.assertEqual(should_stop(rounds, self.profile, queries_used=1), (False, ""))


class EntityProvenanceTests(unittest.TestCase):
    def test_planner_labels_are_not_reported_as_discovered_entities(self):
        """Regression: coverage.entities used to echo the taxonomy labels.

        A real 87-URL run reported exactly the six family labels as its
        entities, so a run that discovered nothing still looked healthy.
        """
        family = {
            "family_id": "q01-entity",
            "query": "ByteDance 红果短剧",
            "dimension": "entity",
            "dimension_label": "products",
            "entity_focus": ["products"],
            "topic": "candidate products",
        }
        rows = annotate_items([{"url": "https://a.test/1", "title": "t"}], family)
        self.assertEqual(rows[0]["entities"], [])
        self.assertEqual(rows[0]["dimension_label"], "products")
        metrics = coverage_metrics(rows, [family])
        self.assertNotIn("products", metrics["entities"])


class RoutingTests(unittest.TestCase):
    def test_dimension_routes_to_relevant_sites(self):
        default = "google,reddit,x,sogou-weixin"
        self.assertEqual(sites_for_dimension("community", default), "reddit,x,google")
        self.assertEqual(sites_for_dimension("regional", default), "sogou-weixin,google")

    def test_routing_never_exceeds_configured_sites(self):
        self.assertEqual(sites_for_dimension("community", "google"), "google")

    def test_unknown_dimension_uses_default(self):
        self.assertEqual(sites_for_dimension("whatever", "google,reddit"), "google,reddit")



class BreadthPlannerTests(unittest.TestCase):
    def test_legacy_route_is_one_seed_family(self):
        profile, candidates, selected = profile_families("vibecoding dashboard", "legacy", "deep")
        self.assertEqual(profile["mode"], "legacy")
        self.assertEqual(len(candidates), 1)
        self.assertEqual(len(selected), 1)
        self.assertEqual(selected[0]["family_id"], "q00-seed")

    def test_width_selects_diverse_families(self):
        profile, candidates, selected = profile_families("vibecoding 管理看板类产品", "wide", "fast")
        self.assertEqual(profile["depth"]["profile"], "fast")
        self.assertEqual(len(selected), 6)
        # Diversity now lives in the routing dimension, not in padded query
        # text: queries are deliberately short and reuse the user's own words.
        self.assertGreater(len({item["dimension"] for item in selected}), 3)
        for index, left in enumerate(selected):
            for right in selected[index + 1 :]:
                if left["dimension"] == right["dimension"]:
                    self.assertLessEqual(query_similarity(left["query"], right["query"]), 0.65)

    def test_selector_fills_small_candidate_pool(self):
        families = [
            {"family_id": "a", "query": "same query", "rank": 1},
            {"family_id": "b", "query": "same query", "rank": 2},
        ]
        selected = select_diverse_query_families(families, 2, max_similarity=0.01)
        self.assertEqual([item["family_id"] for item in selected], ["a", "b"])


class CoverageMetricTests(unittest.TestCase):
    def test_fixture_width_has_more_coverage_than_legacy(self):
        result = compare(load_fixture(FIXTURE))
        self.assertGreater(result["new"]["entity_count"], result["old"]["entity_count"])
        self.assertGreater(result["new"]["topic_count"], result["old"]["topic_count"])
        self.assertGreater(result["new"]["perspective_count"], result["old"]["perspective_count"])
        self.assertGreater(result["new"]["source_type_count"], result["old"]["source_type_count"])
        self.assertGreater(result["new"]["path_diversity"], result["old"]["path_diversity"])

    def test_metrics_count_family_ids_preserved_after_dedupe(self):
        families = [
            {"family_id": "a", "dimension": "entity"},
            {"family_id": "b", "dimension": "community"},
        ]
        items = [
            {"url": "https://example.test/shared", "family_ids": ["a", "b"], "plane": "smart-search:search", "topics": ["one"]},
            {"url": "https://example.test/unique", "family_id": "b", "plane": "browser:google", "topics": ["two"]},
        ]
        metrics = coverage_metrics(items, families)
        self.assertEqual(metrics["query_families_hit"], 2)
        self.assertEqual(metrics["query_families_planned"], 2)
        self.assertEqual(metrics["topic_count"], 2)
        self.assertGreater(metrics["path_diversity"], 0)


class BreadthCliTests(unittest.TestCase):
    def test_manifest_records_independent_width_and_depth(self):
        script = SCRIPT_DIR / "multi_source_search.py"
        with tempfile.TemporaryDirectory() as tmp:
            subprocess.run(
                [
                    sys.executable,
                    str(script),
                    "vibecoding 管理看板类产品",
                    "--planes",
                    "none",
                    "--planner",
                    "legacy",
                    "--width",
                    "wide",
                    "--depth",
                    "fast",
                    "--no-parallel",
                    "--out",
                    tmp,
                ],
                check=True,
                capture_output=True,
                text=True,
            )
            manifest = json.loads((Path(tmp) / "manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(manifest["width"], "wide")
            self.assertEqual(manifest["depth"], "fast")
            self.assertEqual(manifest["query_family_count"], 6)
            self.assertEqual(manifest["coverage"]["query_families_planned"], 6)
            self.assertTrue((Path(tmp) / "query_families.json").is_file())
            # Progressive-loop bookkeeping must always be recorded.
            self.assertIn("rounds", manifest)
            self.assertIn("stop_reason", manifest)
            self.assertIn("discovery", manifest)
            # With no planes there is nothing to mine, so entities must be
            # empty rather than echoing the planner's own labels.
            self.assertEqual(manifest["coverage"]["entities"], [])


if __name__ == "__main__":
    unittest.main()
