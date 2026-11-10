import copy
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
from query_planner import PlanError, SemanticPlanner, validate_plan, merge_evidence
from semantic import run_semantic
from breadth import profile_families
from progressive import run_progressive


def decision(queries=(), relevant=(), candidates=(), sufficient=False, constraints=()):
    return {"task": {"target": "研究资料", "intent": "搜集概念定义、方法与证据", "hard_constraints": list(constraints),
                     "preferences": [], "unknowns": []}, "relations": [],
            "review": {"relevant_urls": list(relevant), "rejected": [], "candidates": list(candidates),
                       "gaps": [] if sufficient else ["需要相关研究证据"],
                       "constraints_unknown": [], "sufficient": sufficient},
            "queries": list(queries)}


def search(text, purpose="resolve", refs=(), planes=("smart",), kind="entity"):
    return {"concepts": [{"text": text, "kind": kind}], "purpose": purpose,
            "operation": "exact" if purpose == "resolve" else "relation",
            "rationale": "test retrieval", "evidence_urls": list(refs),
            "planes": list(planes), "sites": ["google"]}


class SequencePlanner:
    def __init__(self, decisions):
        self.decisions = decisions
        self.requests = []

    def decide(self, request):
        self.requests.append(copy.deepcopy(request))
        return validate_plan(copy.deepcopy(self.decisions[len(self.requests)-1]), request)


class SemanticBehaviorTests(unittest.TestCase):
    QUERY = "了解星辰框架背后的知识检索方法"
    CONTEXT = {"url": "https://reference.test/framework", "title": "星辰框架",
                "snippet": "星辰框架采用概念索引方法。"}
    FINDING = {"url": "https://papers.test/evidence", "title": "概念索引研究综述",
            "snippet": "概念索引方法的代表性研究包括语义图谱论文。"}

    def request(self, evidence=()):
        return {"query": self.QUERY, "task": {}, "evidence": list(evidence),
                "available_planes": ["smart", "browser"], "available_sites": ["google"],
                "query_limit": 4, "decision_index": 0, "final": False}

    def test_resolve_replace_anchor_and_review_last_batch(self):
        initial = decision([search("星辰框架")])
        followup = decision([search("概念索引", "discover", [self.CONTEXT["url"]])], [self.CONTEXT["url"]])
        followup["queries"][0]["concepts"].append({"text": "研究", "kind": "intent"})
        followup["relations"] = [{"subject": "星辰框架", "relation": "uses_method", "object": "概念索引",
                                   "status": "verified", "evidence_url": self.CONTEXT["url"],
                                   "quote": self.CONTEXT["snippet"]}]
        final = decision(relevant=[self.CONTEXT["url"], self.FINDING["url"]],
                         candidates=[{"name": "语义图谱论文", "evidence_url": self.FINDING["url"]}], sufficient=True)
        planner = SequencePlanner([initial, followup, final])
        calls = []
        def retrieve(families):
            calls.extend(f["query"] for f in families)
            return [([self.CONTEXT if f["query"] == "星辰框架" else self.FINDING], {}) for f in families]
        result = run_semantic(self.QUERY, planner, retrieve, planes={"smart"}, sites={"google"}, rounds=2)
        self.assertEqual(calls, ["星辰框架", "概念索引 研究"])
        self.assertEqual(result["stop_reason"], "evidence_sufficient")
        self.assertEqual([x["term"] for x in result["mined_terms"]], ["语义图谱论文"])
        self.assertTrue(planner.requests[-1]["final"])
        self.assertIn(self.FINDING["url"], [x["url"] for x in planner.requests[-1]["evidence"]])

    def test_unobserved_term_cannot_be_asserted_or_searched_as_known(self):
        with self.assertRaises(PlanError):
            validate_plan(decision([search("概念索引", "discover")]), self.request())
        hypothesis = decision([search("概念索引", "resolve")])
        self.assertTrue(validate_plan(hypothesis, self.request())["queries"])

    def test_relation_requires_quote_from_observed_source(self):
        p = decision()
        p["relations"] = [{"subject": "星辰框架", "relation": "uses_method", "object": "关键词堆叠",
                           "status": "verified", "evidence_url": self.CONTEXT["url"], "quote": "使用关键词堆叠"}]
        with self.assertRaises(PlanError):
            validate_plan(p, self.request([self.CONTEXT]))

    def test_overlong_chinese_request_exceeds_concept_budget(self):
        with self.assertRaises(PlanError):
            validate_plan(decision([search("请帮我搜集星辰框架的概念定义与知识检索方法相关研究资料" * 4)]), self.request())

    def test_hard_constraints_cannot_disappear(self):
        req = self.request()
        req["task"] = {"hard_constraints": ["仅使用一手研究来源"]}
        with self.assertRaises(PlanError):
            validate_plan(decision(), req)

    def test_candidates_must_be_in_relevant_evidence(self):
        p = decision(relevant=[self.CONTEXT["url"]], candidates=[{"name": "不存在的研究论文", "evidence_url": self.CONTEXT["url"]}])
        with self.assertRaises(PlanError):
            validate_plan(p, self.request([self.CONTEXT]))

    def test_failed_sources_are_not_saturation(self):
        p = SequencePlanner([decision([search("星辰框架")]), decision()])
        result = run_semantic(self.QUERY, p, lambda fs: [([], {"errors": ["timeout"]}) for _ in fs],
                              planes={"smart"}, sites={"google"}, rounds=1)
        self.assertEqual(result["stop_reason"], "source_failure")
        self.assertEqual(result["queries_used"], 1)

    def test_resolution_is_read_before_discovery(self):
        p = SequencePlanner([decision([search("星辰框架"),
                                      search("星辰框架", "discover")]), decision()])
        calls = []
        def retrieve(fs):
            calls.extend(fs)
            return [([self.CONTEXT], {}) for _ in fs]
        run_semantic(self.QUERY, p, retrieve, planes={"smart"}, sites={"google"}, rounds=1)
        self.assertEqual([x["purpose"] for x in calls], ["resolve"])
        self.assertTrue(p.requests[-1]["final"])

    def test_duplicate_empty_provider_cannot_erase_snippet(self):
        rows = [self.CONTEXT, dict(self.CONTEXT, snippet="")]
        self.assertEqual(merge_evidence(rows)[0]["snippet"], self.CONTEXT["snippet"])
        p = SequencePlanner([decision([search("星辰框架")]), decision()])
        run_semantic(self.QUERY, p, lambda fs: [(rows, {})], planes={"smart"}, sites={"google"}, rounds=1)
        self.assertEqual(p.requests[-1]["evidence"][0]["snippet"], self.CONTEXT["snippet"])

    def test_cli_source_failure_is_nonzero(self):
        import multi_source_search as cli
        with tempfile.TemporaryDirectory() as tmp:
            plan = Path(tmp) / "plan.json"
            plan.write_text(json.dumps({"decisions": [decision([search("星辰框架")]), decision()]}))
            argv = ["search", self.QUERY, "--planner", "agent", "--query-plan", str(plan),
                    "--planes", "smart", "--rounds", "1", "-o", tmp]
            with patch.object(sys, "argv", argv), patch.object(cli, "run_query_family", return_value=([], {"errors": ["timeout"]})):
                self.assertEqual(cli.main(), 4)

    def test_wrapper_does_not_synthesize_failed_sources(self):
        import deep_research as cli
        with tempfile.TemporaryDirectory() as tmp, patch.object(sys, "argv", ["deep", self.QUERY, "-o", tmp, "--no-gptr"]), \
                patch.object(cli, "run_multi", return_value={"stop_reason": "source_failure"}), \
                patch.object(cli, "simple_md_report") as synthesize:
            self.assertEqual(cli.main(), 4)
            synthesize.assert_not_called()

    def test_malformed_or_contradictory_review_is_rejected(self):
        for rejected in (None, [None], [{"url": self.CONTEXT["url"], "reason": "irrelevant"}]):
            p = decision(relevant=[self.CONTEXT["url"]]); p["review"]["rejected"] = rejected
            with self.assertRaises(PlanError):
                validate_plan(p, self.request([self.CONTEXT]))

    def test_provider_overlap_is_removed_before_dispatch(self):
        p = SequencePlanner([decision([search("星辰框架"), search("星辰框架", planes=("smart", "browser"))]), decision()])
        calls = []
        def retrieve(fs):
            calls.extend(fs)
            return [([self.CONTEXT], {}) for _ in fs]
        run_semantic(self.QUERY, p, retrieve, planes={"smart", "browser"}, sites={"google"}, rounds=1)
        self.assertEqual([x["planes"] for x in calls], [["smart"], ["browser"]])

    def test_budget_charges_only_allowed_jobs_including_failure(self):
        p = SequencePlanner([decision([search("星辰框架")]), decision()])
        result = run_semantic(self.QUERY, p, lambda fs: [([], {"errors": ["timeout"]})],
                              planes={"smart"}, sites={"google"}, rounds=3, max_queries=1)
        self.assertEqual(result["queries_used"], 1)
        self.assertEqual(p.requests[-1]["query_limit"], 0)

    def test_legacy_budget_cannot_overshoot(self):
        profile, _, families = profile_families(self.QUERY, "legacy", rounds=2)
        rows = [{"term": x, "sample_url": self.CONTEXT["url"], "doc_freq": 2}
                for x in ("概念图", "语义索引", "术语映射", "知识组织")]
        with patch("progressive.mine_terms", return_value=rows):
            result = run_progressive(self.QUERY, families, profile,
                                     lambda fs: [([self.CONTEXT], {}) for _ in fs], rounds=2)
        self.assertEqual(result["queries_used"], 2)

    def test_agent_mode_pauses_instead_of_falling_back(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = run_semantic(self.QUERY, SemanticPlanner(Path(tmp), "agent"), lambda _: self.fail("must not search"),
                                  planes={"smart"}, sites={"google"})
            self.assertEqual(result["stop_reason"], "needs_query_plan")
            self.assertTrue((Path(tmp) / "planner_request.json").is_file())

    def test_cli_no_parallel_does_not_search_twice(self):
        # The old CLI had an extra pre-loop search when --no-parallel was set.
        import multi_source_search as cli
        with tempfile.TemporaryDirectory() as tmp, patch.object(cli, "run_query_family", return_value=([], {"errors": ["test"]})) as run:
            argv = ["search", "测试查询", "--planner", "legacy", "--planes", "smart", "--width", "legacy",
                    "--rounds", "1", "--no-parallel", "-o", tmp]
            with patch.object(sys, "argv", argv):
                cli.main()
            self.assertEqual(run.call_count, 1)


if __name__ == "__main__":
    unittest.main()
