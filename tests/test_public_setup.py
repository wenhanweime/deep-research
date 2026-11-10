import contextlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import runtime_config
import setup as onboarding
import multi_source_search as search
from check_public import scan_content

class PublicSetupTests(unittest.TestCase):
    def test_external_file_process_precedence_and_no_command_execution(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = Path(tmp) / ".env"
            env.write_text("TAVILY_API_KEY=file-value\nEXA_API_KEY='literal-$(never-execute)'\n")
            with patch.dict(os.environ, {"DEEP_RESEARCH_CONFIG_DIR": tmp, "TAVILY_API_KEY": "process-value"}, clear=True):
                runtime_config.load_config()
                self.assertEqual(os.environ["TAVILY_API_KEY"], "process-value")
                self.assertEqual(os.environ["EXA_API_KEY"], "literal-$(never-execute)")
                self.assertEqual(os.environ["SMART_SEARCH_CONFIG_DIR"], str(Path(tmp).resolve() / "smart-search"))
                self.assertIn(str(Path(tmp).resolve()), os.environ["CODEX_AUTH_FILE"])

    def test_init_is_private_idempotent_and_preserves_existing_keys(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {"DEEP_RESEARCH_CONFIG_DIR": str(Path(tmp) / "private")}, clear=True), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(onboarding.init(True), 0)
            target = runtime_config.env_file()
            self.assertEqual(target.stat().st_mode & 0o777, 0o600)
            self.assertEqual(target.parent.stat().st_mode & 0o777, 0o700)
            target.write_text("TAVILY_API_KEY=keep-me\n")
            onboarding.init(True)
            self.assertEqual(target.read_text(), "TAVILY_API_KEY=keep-me\n")

    def test_init_rejects_repository_secret_destination(self):
        with patch.dict(os.environ, {"DEEP_RESEARCH_ENV_FILE": str(runtime_config.ROOT / "private/.env")}):
            with self.assertRaises(ValueError):
                onboarding.init(True)

    def test_direct_apis_work_without_smart_search_binary(self):
        response = unittest.mock.MagicMock()
        response.__enter__.return_value.read.return_value = json.dumps({"results": [{"url": "https://example.org", "title": "Result", "content": "Evidence"}]}).encode()
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {"TAVILY_API_KEY": "test-value", "EXA_API_KEY": "test-value"}, clear=True), patch.object(search, "SMART_SEARCH", ""), patch("urllib.request.urlopen", return_value=response) as request:
            items = search.smart_search_plane("query", Path(tmp))
            self.assertEqual(request.call_count, 2)
            self.assertEqual({row["plane"] for row in items}, {"api:exa", "api:tavily"})

    def test_doctor_offline_never_calls_providers_or_prints_keys(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {"DEEP_RESEARCH_CONFIG_DIR": tmp, "TAVILY_API_KEY": "hidden-value"}, clear=True), patch("urllib.request.urlopen") as request, contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(onboarding.doctor(False, "tavily"), 0)
            request.assert_not_called()
            self.assertNotIn("hidden-value", output.getvalue())
            self.assertIn("not verified", output.getvalue())

    def test_doctor_online_failure_is_nonzero_and_redacted(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {"DEEP_RESEARCH_CONFIG_DIR": tmp, "EXA_API_KEY": "hidden-value"}, clear=True), patch("urllib.request.urlopen", side_effect=OSError("hidden-value")), contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(onboarding.doctor(True, "exa"), 1)
            self.assertNotIn("hidden-value", output.getvalue())

    def test_scanner_flags_realistic_token_without_embedding_one(self):
        self.assertTrue(scan_content("sk-" + "A" * 32))
        self.assertFalse(scan_content("EXA_API_KEY=\n"))

if __name__ == "__main__":
    unittest.main()
