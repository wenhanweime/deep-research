#!/usr/bin/env python3
"""Publish a research report.md to a new Feishu Docx in 个人目录 + optional IM notify.

个人目录 = Wiki personal library (my_library / 我的文档库), NOT cloud-drive root.

Correct path:
  1) wiki +node-create --as user --space-id my_library  → empty docx in personal library
  2) docs +update --command overwrite --doc-format markdown → fill body
  3) (default) bot IM notify user with title + wiki URL

Legacy docs +create --parent-position my_library only produces a Drive /docx/
URL that appears under 网盘; do not use that as the default any more.

Notify defaults ON after successful publish. Failures in notify do not fail publish
(ok remains true; notify.ok may be false). Use --no-notify to skip.

Also usable as notify-only helper for XML publish paths (expert-research):
  publish_feishu.py --notify-only --title "..." --url "https://.../wiki/..." --skill expert-research
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path


TITLE_RE = re.compile(r"^#\s+(.+?)\s*$", re.MULTILINE)

# Last-resort default for this machine's primary user (overridden by auth status / env).
from runtime_config import load_config

DEFAULT_NOTIFY_USER_OPEN_ID = ""


def extract_title(text: str, fallback: str) -> str:
    match = TITLE_RE.search(text)
    if not match:
        return fallback
    title = re.sub(r"[*_`]+", "", match.group(1)).strip()
    return title[:180] or fallback


def lark_env() -> dict:
    env = os.environ.copy()
    env["LARKSUITE_CLI_NO_UPDATE_NOTIFIER"] = "1"
    env["LARKSUITE_CLI_NO_SKILLS_NOTIFIER"] = "1"
    return env


def run_json(cmd: list[str], *, cwd: Path | None = None) -> dict:
    proc = subprocess.run(
        cmd,
        cwd=str(cwd) if cwd else None,
        env=lark_env(),
        capture_output=True,
        text=True,
    )
    raw = (proc.stdout or "").strip() or (proc.stderr or "").strip()
    # Some lark-cli versions print trailing notices after JSON
    payload: dict
    try:
        payload = json.loads(raw) if raw else {}
    except json.JSONDecodeError:
        # try first JSON object in stdout
        start = raw.find("{")
        end = raw.rfind("}")
        if start >= 0 and end > start:
            try:
                payload = json.loads(raw[start : end + 1])
            except json.JSONDecodeError:
                payload = {
                    "ok": False,
                    "error": {"message": raw or "non-json lark-cli output"},
                }
        else:
            payload = {
                "ok": False,
                "error": {"message": raw or "non-json lark-cli output"},
            }
    if proc.returncode != 0:
        payload.setdefault("ok", False)
        payload.setdefault(
            "error",
            {
                "message": f"lark-cli exit {proc.returncode}",
                "stdout": proc.stdout,
                "stderr": proc.stderr,
            },
        )
    return payload


def resolve_notify_user_id(explicit: str = "") -> str:
    if explicit.strip():
        return explicit.strip()
    for key in (
        "FEISHU_RESEARCH_NOTIFY_USER_ID",
        "FEISHU_NOTIFY_USER_ID",
        "LARK_NOTIFY_USER_OPEN_ID",
    ):
        val = (os.environ.get(key) or "").strip()
        if val:
            return val
    status = run_json(["lark-cli", "auth", "status", "--json"])
    try:
        user = (status.get("identities") or {}).get("user") or {}
        oid = (user.get("openId") or user.get("open_id") or "").strip()
        if oid:
            return oid
    except Exception:
        pass
    return DEFAULT_NOTIFY_USER_OPEN_ID


def build_notify_markdown(
    *,
    title: str,
    url: str,
    skill: str = "",
    location: str = "",
    summary: str = "",
    report: str = "",
) -> str:
    lines = [
        "## 调研文档已发布",
        "",
        f"**{title}**",
        "",
        f"[打开飞书文档]({url})" if url else "（无 URL）",
    ]
    if skill:
        lines.extend(["", f"- skill：`{skill}`"])
    if location:
        lines.append(f"- 位置：{location}")
    if summary:
        lines.extend(["", summary.strip()[:500]])
    if report:
        lines.append(f"- 本地：`{report}`")
    lines.append("")
    return "\n".join(lines)


def notify_research_published(
    *,
    title: str,
    url: str,
    skill: str = "deep-research",
    location: str = "",
    summary: str = "",
    report: str = "",
    user_id: str = "",
    chat_id: str = "",
    as_identity: str = "bot",
) -> dict:
    """Send Feishu IM after publish. Prefer bot DM to user; optional group chat_id."""
    md = build_notify_markdown(
        title=title,
        url=url,
        skill=skill,
        location=location,
        summary=summary,
        report=report,
    )
    cmd = [
        "lark-cli",
        "im",
        "+messages-send",
        "--as",
        as_identity,
        "--markdown",
        md,
        "--format",
        "json",
    ]
    chat_id = (chat_id or os.environ.get("FEISHU_RESEARCH_NOTIFY_CHAT_ID") or "").strip()
    if chat_id:
        cmd.extend(["--chat-id", chat_id])
        target = {"type": "chat", "id": chat_id}
    else:
        uid = resolve_notify_user_id(user_id)
        if not uid:
            return {
                "ok": False,
                "error": "no notify user open_id resolved",
            }
        cmd.extend(["--user-id", uid])
        target = {"type": "user", "id": uid}

    payload = run_json(cmd)
    # Normalize ok: some CLI return message_id without ok=true
    data = payload.get("data") if isinstance(payload.get("data"), dict) else payload
    mid = ""
    if isinstance(data, dict):
        mid = str(data.get("message_id") or "")
    if mid and payload.get("ok") is not False:
        payload["ok"] = True
    result = {
        "ok": bool(payload.get("ok")),
        "target": target,
        "identity": as_identity,
        "message_id": mid,
        "raw": payload,
    }
    if not result["ok"]:
        result["error"] = payload.get("error") or payload
    return result


def missing_wiki_scope(payload: dict) -> bool:
    err = payload.get("error") or {}
    if err.get("subtype") == "missing_scope":
        scopes = err.get("missing_scopes") or []
        return any(str(s).startswith("wiki:") for s in scopes)
    msg = str(err.get("message") or "")
    return "wiki:" in msg and "missing" in msg.lower()


def create_in_personal_library(title: str) -> dict:
    """Create empty docx node under Wiki my_library (个人目录)."""
    return run_json(
        [
            "lark-cli",
            "wiki",
            "+node-create",
            "--as",
            "user",
            "--space-id",
            "my_library",
            "--obj-type",
            "docx",
            "--title",
            title,
            "--format",
            "json",
        ]
    )


def overwrite_markdown(doc_token: str, report: Path) -> dict:
    return run_json(
        [
            "lark-cli",
            "docs",
            "+update",
            "--as",
            "user",
            "--doc",
            doc_token,
            "--command",
            "overwrite",
            "--doc-format",
            "markdown",
            "--content",
            f"@{report.name}",
            "--format",
            "json",
        ],
        cwd=report.parent,
    )


def legacy_drive_create(report: Path, title: str) -> dict:
    """Fallback only when wiki scopes are missing (lands in 网盘)."""
    return run_json(
        [
            "lark-cli",
            "docs",
            "+create",
            "--as",
            "user",
            "--parent-position",
            "my_library",
            "--doc-format",
            "markdown",
            "--title",
            title,
            "--content",
            f"@{report.name}",
            "--format",
            "json",
        ],
        cwd=report.parent,
    )


def extract_node_fields(payload: dict) -> tuple[str, str, str]:
    """Return (node_token, obj_token, url_hint) from wiki +node-create payload."""
    data = payload.get("data") or payload
    node = data.get("node") if isinstance(data.get("node"), dict) else data
    if not isinstance(node, dict):
        node = {}
    obj_token = (
        node.get("obj_token")
        or data.get("obj_token")
        or (data.get("document") or {}).get("document_id")
        or node.get("obj_token")
        or ""
    )
    node_token = (
        node.get("node_token")
        or data.get("node_token")
        or node.get("token")
        or data.get("token")
        or ""
    )
    url_hint = (
        node.get("url")
        or data.get("url")
        or node.get("node_url")
        or data.get("node_url")
        or ""
    )
    return str(node_token or ""), str(obj_token or ""), str(url_hint or "")


def build_wiki_url(node_token: str | None, obj_token: str, url_hint: str = "") -> str:
    """Prefer /wiki/<node_token>. Never claim personal-library for bare /docx/ alone."""
    if url_hint and "/wiki/" in url_hint:
        return url_hint.split("?")[0].rstrip("/")
    if node_token:
        return f"https://my.feishu.cn/wiki/{node_token}"
    if obj_token:
        # Last resort — caller must not treat this as personal-library success
        return f"https://my.feishu.cn/docx/{obj_token}"
    return ""


def is_wiki_url(url: str) -> bool:
    return bool(url) and "/wiki/" in url


def write_handoff(
    outdir: Path,
    title: str,
    url: str,
    document_id: str,
    report: Path,
    *,
    location: str,
    method: str,
    node_token: str = "",
    warning: str = "",
    notify: dict | None = None,
) -> None:
    created = datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
    (outdir / "FEISHU.url").write_text(url + "\n", encoding="utf-8")
    lines = [
        "# 飞书文档",
        "",
        f"- 标题：{title}",
        f"- URL：{url}",
        f"- document_id：{document_id}",
        f"- 创建时间：{created}",
        f"- 方法：{method}",
        f"- 位置：{location}",
    ]
    if node_token:
        lines.append(f"- wiki_node_token：{node_token}")
    if document_id and "/wiki/" in url:
        lines.append(f"- 云文档 obj（同正文，勿单独当个人目录入口）：https://my.feishu.cn/docx/{document_id}")
    if warning:
        lines.append(f"- 警告：{warning}")
    if notify is not None:
        lines.append(f"- IM 通知：{'ok' if notify.get('ok') else 'failed/skipped'}")
        if notify.get("message_id"):
            lines.append(f"- IM message_id：{notify.get('message_id')}")
        if notify.get("target"):
            lines.append(f"- IM target：{json.dumps(notify.get('target'), ensure_ascii=False)}")
        if notify.get("error"):
            lines.append(f"- IM 错误：{notify.get('error')}")
    lines.append("")
    lines.append(
        "> 个人目录交付必须以 `/wiki/<node_token>` 为准；"
        "用户侧栏「个人文档 / 我的文档库」对应 Wiki 节点。"
    )
    lines.append("")
    (outdir / "FEISHU.md").write_text("\n".join(lines), encoding="utf-8")
    if notify is not None:
        (outdir / "FEISHU_NOTIFY.json").write_text(
            json.dumps(notify, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )


def maybe_notify(
    *,
    enabled: bool,
    title: str,
    url: str,
    skill: str,
    location: str,
    report: Path | None,
    user_id: str,
    chat_id: str,
    as_identity: str,
    summary: str,
) -> dict | None:
    if not enabled:
        return {"ok": False, "skipped": True, "reason": "notify disabled"}
    return notify_research_published(
        title=title,
        url=url,
        skill=skill,
        location=location,
        summary=summary,
        report=str(report) if report else "",
        user_id=user_id,
        chat_id=chat_id,
        as_identity=as_identity,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--report",
        type=Path,
        default=None,
        help="Path to report.md (required unless --notify-only)",
    )
    parser.add_argument("--title", default="", help="Optional Feishu title override")
    parser.add_argument(
        "--allow-drive-fallback",
        action="store_true",
        help="If wiki personal-library scopes are missing, fall back to Drive docs +create (网盘)",
    )
    parser.add_argument(
        "--notify",
        dest="notify",
        action="store_true",
        default=False,
        help="Explicitly enable Feishu IM after publishing",
    )
    parser.add_argument(
        "--no-notify",
        dest="notify",
        action="store_false",
        help="Skip Feishu IM notify after publish",
    )
    parser.add_argument(
        "--notify-only",
        action="store_true",
        help="Only send IM for an existing title+url (no wiki create)",
    )
    parser.add_argument(
        "--url",
        default="",
        help="Document URL for --notify-only (or override in payload)",
    )
    parser.add_argument(
        "--skill",
        default="deep-research",
        help="Skill name shown in notify message",
    )
    parser.add_argument(
        "--summary",
        default="",
        help="Optional one-line summary in notify body",
    )
    parser.add_argument(
        "--notify-user-id",
        default="",
        help="Recipient open_id (default: auth status user / env / built-in)",
    )
    parser.add_argument(
        "--notify-chat-id",
        default="",
        help="If set, notify this group chat instead of DM",
    )
    parser.add_argument(
        "--notify-as",
        default="bot",
        choices=["bot", "user"],
        help="IM send identity (default bot)",
    )
    args = parser.parse_args()

    # --- notify-only path (expert-research XML publish, etc.) ---
    if args.notify_only:
        title = args.title.strip() or "调研文档"
        url = args.url.strip()
        if not url:
            print(
                json.dumps(
                    {"ok": False, "error": "--notify-only requires --url"},
                    ensure_ascii=False,
                )
            )
            return 1
        notify = maybe_notify(
            enabled=True,
            title=title,
            url=url,
            skill=args.skill,
            location="(existing document)",
            report=args.report.expanduser().resolve() if args.report else None,
            user_id=args.notify_user_id,
            chat_id=args.notify_chat_id,
            as_identity=args.notify_as,
            summary=args.summary,
        )
        print(json.dumps({"ok": True, "notify": notify, "url": url, "title": title}, ensure_ascii=False, indent=2))
        # notify failure is soft
        return 0

    if args.report is None:
        print(
            json.dumps(
                {"ok": False, "error": "--report is required unless --notify-only"},
                ensure_ascii=False,
            )
        )
        return 1

    report = args.report.expanduser().resolve()
    if not report.is_file():
        print(json.dumps({"ok": False, "error": f"report not found: {report}"}, ensure_ascii=False))
        return 1

    text = report.read_text(encoding="utf-8")
    title = args.title.strip() or extract_title(text, report.parent.name)

    # Preferred: Wiki 个人目录
    node_payload = create_in_personal_library(title)
    if node_payload.get("ok"):
        node_token, obj_token, url_hint = extract_node_fields(node_payload)
        if not obj_token:
            print(
                json.dumps(
                    {
                        "ok": False,
                        "error": "wiki node-create ok but missing obj_token",
                        "payload": node_payload,
                    },
                    ensure_ascii=False,
                    indent=2,
                )
            )
            return 1
        if not node_token:
            print(
                json.dumps(
                    {
                        "ok": False,
                        "error": (
                            "wiki node-create ok but missing node_token — "
                            "cannot build /wiki/ personal-library URL"
                        ),
                        "payload": node_payload,
                    },
                    ensure_ascii=False,
                    indent=2,
                )
            )
            return 1

        update_payload = overwrite_markdown(obj_token, report)
        if not update_payload.get("ok"):
            print(
                json.dumps(
                    {
                        "ok": False,
                        "error": "wiki node created but docs +update overwrite failed",
                        "node": node_payload,
                        "update": update_payload,
                    },
                    ensure_ascii=False,
                    indent=2,
                )
            )
            return 1

        url = build_wiki_url(node_token, obj_token, url_hint)
        if not is_wiki_url(url):
            print(
                json.dumps(
                    {
                        "ok": False,
                        "error": "expected /wiki/ personal-library URL after wiki node-create",
                        "url": url,
                        "node_token": node_token,
                        "obj_token": obj_token,
                    },
                    ensure_ascii=False,
                    indent=2,
                )
            )
            return 1

        location = "个人目录 / 我的文档库（Wiki my_library）"
        notify = maybe_notify(
            enabled=args.notify,
            title=title,
            url=url,
            skill=args.skill,
            location=location,
            report=report,
            user_id=args.notify_user_id,
            chat_id=args.notify_chat_id,
            as_identity=args.notify_as,
            summary=args.summary,
        )
        write_handoff(
            report.parent,
            title,
            url,
            obj_token,
            report,
            location=location,
            method="wiki +node-create --space-id my_library + docs +update overwrite markdown",
            node_token=node_token,
            notify=notify,
        )
        print(
            json.dumps(
                {
                    "ok": True,
                    "title": title,
                    "url": url,
                    "document_id": obj_token,
                    "node_token": node_token,
                    "location": "personal_library_wiki",
                    "report": str(report),
                    "feishu_md": str(report.parent / "FEISHU.md"),
                    "notify": notify,
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0

    # Wiki scopes missing → optional Drive fallback (explicit only)
    if missing_wiki_scope(node_payload) and not args.allow_drive_fallback:
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": {
                        "type": "authorization",
                        "subtype": "missing_scope",
                        "message": (
                            "需要 Wiki 个人目录权限才能写到「个人目录/我的文档库」。"
                            "请授权 wiki:node:create wiki:node:read wiki:space:read 后重试。"
                            "不要默认落到云盘；如确需临时网盘可用 --allow-drive-fallback。"
                        ),
                        "missing_scopes": (node_payload.get("error") or {}).get(
                            "missing_scopes"
                        ),
                        "wiki_create_error": node_payload,
                    },
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return 2

    if not args.allow_drive_fallback:
        print(json.dumps(node_payload, ensure_ascii=False, indent=2))
        return 1

    # Explicit Drive fallback (网盘) — only with --allow-drive-fallback
    payload = legacy_drive_create(report, title)
    if not payload.get("ok"):
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 1

    doc = (payload.get("data") or {}).get("document") or {}
    url = doc.get("url") or ""
    document_id = doc.get("document_id") or ""
    if not url:
        print(
            json.dumps(
                {"ok": False, "error": "missing document.url", "payload": payload},
                ensure_ascii=False,
                indent=2,
            )
        )
        return 1

    location = "云盘/网盘（Drive fallback — 非个人目录）"
    notify = maybe_notify(
        enabled=args.notify,
        title=title,
        url=url,
        skill=args.skill,
        location=location,
        report=report,
        user_id=args.notify_user_id,
        chat_id=args.notify_chat_id,
        as_identity=args.notify_as,
        summary=args.summary,
    )
    write_handoff(
        report.parent,
        title,
        url,
        document_id,
        report,
        location=location,
        method="docs +create --parent-position my_library (LEGACY FALLBACK)",
        warning="未写入 Wiki 个人目录；仅 --allow-drive-fallback 时允许",
        notify=notify,
    )
    print(
        json.dumps(
            {
                "ok": True,
                "title": title,
                "url": url,
                "document_id": document_id,
                "location": "drive_fallback",
                "warning": "document landed in cloud drive, not personal wiki library",
                "report": str(report),
                "feishu_md": str(report.parent / "FEISHU.md"),
                "notify": notify,
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
