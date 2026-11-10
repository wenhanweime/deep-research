#!/usr/bin/env python3
import sys
import unittest
from unittest.mock import patch
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPT_DIR))

from browser_search import compress_query_for_site  # noqa: E402
from breadth import MAX_QUERY_TERMS, significant_terms  # noqa: E402
import browser_search


class CompressQueryTests(unittest.TestCase):
    def test_managed_facade_reuses_session_and_unwraps_evaluation(self):
        browser_search.SESSIONS.clear()
        with patch.object(browser_search, "browser_call", side_effect=[{"session_id": "owned-session"}, {}, {"value": [{"url": "https://test.example"}]}]) as call:
            browser_search.cdp("navigate", "--lane", browser_search.DEFAULT_LANE, "https://example.com")
            browser_search.cdp("navigate", "--lane", browser_search.DEFAULT_LANE, "https://example.com/search")
            result = browser_search.extract_json_from_eval(browser_search.cdp("evaluate", "--lane", browser_search.DEFAULT_LANE, "--fn", "() => []"))
            self.assertEqual(result, [{"url": "https://test.example"}])
            self.assertEqual([x.args[0] for x in call.call_args_list], ["browser_open", "browser_navigate", "browser_evaluate"])
            self.assertNotIn("profile_id", call.call_args_list[0].args[1])
            self.assertEqual(call.call_args_list[1].args[1]["session_id"], "owned-session")
        browser_search.SESSIONS.clear()

    def test_sogou_does_not_inject_an_unrelated_domain(self):
        query = "OpenAI Gemini Claude deep research architecture and citation verification"
        result = compress_query_for_site("sogou-weixin", query)
        self.assertNotIn("美团", result)
        self.assertTrue(any(term in result for term in ("OpenAI", "Gemini", "Claude")))
        self.assertLessEqual(len(result), 30)

    def test_x_does_not_inject_an_unrelated_domain(self):
        query = "Linux.do V2EX deep research agent architecture comparison"
        result = compress_query_for_site("x", query)
        self.assertNotIn("美团", result)
        self.assertIn("Linux.do", result)
        self.assertLessEqual(len(result), 60)

    def test_short_user_query_is_unchanged(self):
        query = "LongCat 国产算力"
        self.assertEqual(compress_query_for_site("sogou-weixin", query), query)
        self.assertEqual(compress_query_for_site("x", query), query)
        self.assertEqual(compress_query_for_site("google", query), query)

    def test_google_and_reddit_are_budgeted(self):
        """Regression: these two used to receive the full brief verbatim.

        A measured run had Reddit return zero hits on a long planner-built
        query while the force-truncated Chinese plane returned the most
        results, so an unbounded query is a recall bug, not a neutral default.
        """
        query = (
            "ByteDance departments list 红果短剧 懂车帝 Hong Guo Dongche Di org chart "
            "sub departments category definitions and alternatives taxonomy"
        )
        for site in ("google", "reddit"):
            result = compress_query_for_site(site, query)
            self.assertLessEqual(len(significant_terms(result)), MAX_QUERY_TERMS, site)
            self.assertNotIn("taxonomy", result.lower(), site)
            self.assertNotIn("category definitions", result.lower(), site)
            self.assertIn("ByteDance", result, site)

    def test_multi_word_proper_noun_is_not_cut_in_half(self):
        result = compress_query_for_site("google", "ByteDance 红果短剧 Hong Guo Dongche Di org chart")
        self.assertNotIn("Hong Guo Dongche Di", result.replace("Hong Guo Dongche Di", ""))
        if "Hong" in result:
            self.assertIn("Hong Guo Dongche Di", result)

    def test_no_site_receives_an_empty_query(self):
        for site in ("google", "reddit", "x", "sogou-weixin"):
            result = compress_query_for_site(site, "candidate products and projects")
            self.assertTrue(result.strip(), site)


if __name__ == "__main__":
    unittest.main()
