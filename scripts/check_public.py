#!/usr/bin/env python3
"""Scan publishable Git files without printing secret values. Run before publishing."""
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
PATTERNS = [
    re.compile(r"(?:sk|ghp|gho|xai)[-_][A-Za-z0-9_-]{24,}"),
    re.compile(r"(?:ou|oc)_[a-f0-9]{24,}"),
    re.compile(r"/Users/" + "pot/"),
    re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
]

def scan_content(text):
    return any(pattern.search(text) for pattern in PATTERNS)

def main():
    result = subprocess.run(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], cwd=ROOT, capture_output=True, check=True)
    paths = sorted(set(result.stdout.decode().split("\0")) - {""})
    failures = []
    for name in paths:
        path = ROOT / name
        if not path.is_file():
            continue
        if path.is_symlink():
            failures.append(name + ": symlink must be reviewed")
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        if scan_content(text):
            failures.append(name + ": credential or personal-path pattern")
        if name == "config/.env.example":
            for line in text.splitlines():
                key, sep, value = line.partition("=")
                if sep and any(k in key for k in ("API_KEY", "TOKEN", "PASSWORD")) and value.strip():
                    failures.append(name + ": non-empty secret placeholder")
        if path.name.startswith(".env") and path.name != ".env.example":
            failures.append(name + ": real env file included")
    for failure in failures:
        print(failure)
    print(f"Public scan: {len(paths)} files; {len(failures)} findings (values never printed)")
    return bool(failures)

if __name__ == "__main__":
    sys.exit(main())
