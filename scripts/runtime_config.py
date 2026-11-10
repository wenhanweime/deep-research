"""Portable configuration. No implicit reads of the author's other tools' secrets."""
from __future__ import annotations
import os
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def config_dir():
    return Path(os.environ.get("DEEP_RESEARCH_CONFIG_DIR", str(Path.home() / ".config/deep-research"))).expanduser().resolve()

def env_file():
    return Path(os.environ.get("DEEP_RESEARCH_ENV_FILE", str(config_dir() / ".env"))).expanduser().resolve()

def read_env(path):
    result = {}
    if not path.is_file():
        return result
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:]
        key, sep, value = line.partition("=")
        key, value = key.strip(), value.strip()
        if not sep or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            raise ValueError(f"Invalid configuration at line {number}; expected KEY=value")
        if value.startswith(('"', "'")) and value.endswith(value[0]):
            value = value[1:-1]
        result[key] = value
    return result

def load_config():
    for key, value in read_env(env_file()).items():
        if value:
            os.environ.setdefault(key, value)
    # Keep child tools from silently reading unrelated global configurations.
    os.environ.setdefault("SMART_SEARCH_CONFIG_DIR", str(config_dir() / "smart-search"))
    os.environ.setdefault("LAST30DAYS_CONFIG_DIR", str(config_dir() / "last30days"))
    os.environ.setdefault("CODEX_AUTH_FILE", str(config_dir() / "disabled-codex-auth.json"))
    if os.environ.get("XAI_API_URL"):
        os.environ.setdefault("XAI_BASE_URL", os.environ["XAI_API_URL"])

load_config()
