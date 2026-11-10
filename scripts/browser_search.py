#!/usr/bin/env python3
"""SERP collection through the managed browser-mcp HTTP facade."""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.parse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from breadth import MAX_QUERY_TERMS, enforce_query_budget  # noqa: E402

from runtime_config import load_config

BROWSER_MCP = os.environ.get("DEEP_RESEARCH_BROWSER_BIN") or shutil.which("browser-mcp") or str(Path.home() / ".local/bin/browser-mcp")
SESSIONS: dict[str, str] = {}
DEFAULT_LANE = "cdp-browser-daemon"
DEFAULT_MAX_RESULTS = 30


def browser_call(tool: str, arguments: dict, timeout: int = 120) -> dict:
    cmd = [BROWSER_MCP, "call", tool, json.dumps(arguments, ensure_ascii=False)]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    out = (proc.stdout or "") + (("\n" + proc.stderr) if proc.stderr else "")
    if proc.returncode != 0:
        raise RuntimeError(f"browser-mcp {tool} failed ({proc.returncode}): {out[-800:]}")
    payload = json.loads(proc.stdout)
    if not isinstance(payload, dict) or payload.get("isError") or payload.get("error"):
        raise RuntimeError(f"browser-mcp {tool} returned an error")
    return payload


def cdp(action: str, *args: str, timeout: int = 120) -> str:
    """Compatibility shim; every action goes through browser-mcp, never raw CDP."""
    def option(name):
        return args[args.index(name) + 1]
    lane = option("--lane")
    if action == "navigate":
        url = args[-1]
        if lane not in SESSIONS:
            arguments = {"url": url, "task_id": "deep-research", "background": True}
            if lane != DEFAULT_LANE:
                arguments["profile_id"] = lane
            payload = browser_call("browser_open", arguments, timeout)
            SESSIONS[lane] = payload["session_id"]
        else:
            payload = browser_call("browser_navigate", {"session_id": SESSIONS[lane], "url": url}, timeout)
    elif action == "wait":
        payload = browser_call("browser_wait", {"session_id": SESSIONS[lane],
            "load": option("--load"), "timeout_ms": int(option("--timeout"))}, timeout)
    elif action == "evaluate":
        payload = browser_call("browser_evaluate", {"session_id": SESSIONS[lane], "fn": option("--fn")}, timeout)
        return json.dumps(payload.get("value"), ensure_ascii=False)
    else:
        raise ValueError(f"Unsupported browser action: {action}")
    return json.dumps(payload, ensure_ascii=False)


def ensure_lane(lane: str, headless: bool = False) -> None:
    # Profile launch, locks and recovery belong to the service. Keep --headless
    # accepted for old callers; the managed profile controls its window mode.
    proc = subprocess.run([BROWSER_MCP, "health"], capture_output=True, text=True, timeout=30)
    if proc.returncode:
        raise RuntimeError("browser-mcp health failed; inspect the managed HTTP service")


def extract_json_from_eval(output: str):
    """Best-effort parse evaluate() stdout which may wrap JSON."""
    text = output.strip()
    # try whole
    for candidate in (text,):
        try:
            return json.loads(candidate)
        except Exception:
            pass
    # find first [ or {
    for i, ch in enumerate(text):
        if ch in "[{":
            try:
                return json.loads(text[i:])
            except Exception:
                break
    # regex array
    m = re.search(r"(\[.*\])", text, re.S)
    if m:
        try:
            return json.loads(m.group(1))
        except Exception:
            pass
    return []


GOOGLE_JS = r"""() => {
  const out = [];
  const seen = new Set();
  const push = (url, title, snippet) => {
    if (!url || seen.has(url)) return;
    if (url.includes('google.') && url.includes('/search')) return;
    if (/^https?:\/\/(support|accounts)\.google\./.test(url)) return;
    seen.add(url);
    out.push({url, title: (title||'').slice(0,200), snippet: (snippet||'').slice(0,500), source: 'google'});
  };
  document.querySelectorAll('div.g, div[data-sokoban-container], div.MjjYud').forEach(el => {
    const h = el.querySelector('h3');
    if (!h) return;
    const a = h.closest('a') || el.querySelector('a[href^="http"]');
    if (!a) return;
    const sn = el.querySelector('.VwiC3b, .yXK7lf, span[style*="-webkit-line-clamp"], div[data-sncf]');
    push(a.href, h ? h.innerText : a.innerText, sn ? sn.innerText : '');
  });
  return out.slice(0, __MAX_RESULTS__);
}"""

REDDIT_JS = r"""() => {
  const out = [];
  const seen = new Set();
  document.querySelectorAll('a[href*="/r/"], a[href*="reddit.com"]').forEach(a => {
    const href = a.href || '';
    if (!href || seen.has(href)) return;
    if (href.includes('/search') || href.includes('login') || href.includes('ads')) return;
    if (!href.includes('/comments/') && !/\/r\/[^/]+\/?$/.test(new URL(href).pathname) && !href.includes('/r/')) return;
    const title = (a.innerText || a.getAttribute('aria-label') || '').trim();
    if (title.length < 4 && !href.includes('/comments/')) return;
    seen.add(href);
    out.push({url: href, title: title.slice(0,200), snippet: '', source: 'reddit'});
  });
  // shreddit post titles
  document.querySelectorAll('faceplate-tracker a, article a, shreddit-post a').forEach(a => {
    const href = a.href || '';
    if (!href.includes('/comments/') || seen.has(href)) return;
    seen.add(href);
    out.push({url: href, title: (a.innerText||'').trim().slice(0,200), snippet: '', source: 'reddit'});
  });
  return out.slice(0, __MAX_RESULTS__);
}"""

X_JS = r"""() => {
  const out = [];
  const seen = new Set();
  document.querySelectorAll('article a[href*="/status/"], a[href*="/status/"]').forEach(a => {
    let href = a.href || '';
    if (!href || seen.has(href)) return;
    // normalize x.com / twitter.com
    href = href.split('?')[0];
    if (!href.includes('/status/')) return;
    seen.add(href);
    const article = a.closest('article');
    const text = article ? article.innerText : a.innerText;
    out.push({url: href, title: (text||'').trim().slice(0,160), snippet: (text||'').trim().slice(0,500), source: 'x'});
  });
  if (out.length < 2) {
    document.querySelectorAll('a[href*="/status/"]').forEach(a => {
      const href = (a.href||'').split('?')[0];
      if (!href.includes('/status/') || seen.has(href)) return;
      seen.add(href);
      out.push({url: href, title: (a.innerText||'').trim().slice(0,160), snippet: '', source: 'x'});
    });
  }
  return out.slice(0, __MAX_RESULTS__);
}"""

# 搜狗微信搜索 https://weixin.sogou.com/  type=2 文章
SOGOU_WEIXIN_JS = r"""() => {
  const out = [];
  const seen = new Set();
  const push = (url, title, snippet, account) => {
    if (!url || seen.has(url)) return;
    // skip pure navigation chrome
    if (url.includes('weixin.sogou.com/weixin?') && !url.includes('type=')) return;
    seen.add(url);
    const sn = [account, snippet].filter(Boolean).join(' | ');
    out.push({
      url,
      title: (title || '').trim().slice(0, 200),
      snippet: (sn || '').trim().slice(0, 500),
      source: 'sogou-weixin',
      account: (account || '').trim().slice(0, 80),
    });
  };

  // Classic result cards: ul.news-list > li
  document.querySelectorAll('ul.news-list li, .news-box li, .results .txt-box, .news-list2 li').forEach(li => {
    const a = li.querySelector('h3 a, .tit a, a[uigs], a[href*="link?url="], a[href*="mp.weixin.qq.com"]');
    if (!a) return;
    const title = a.innerText || a.getAttribute('title') || '';
    const href = a.href || '';
    const accountEl = li.querySelector('.all-time-y2, .s-p a, a.account, .account, label[name="em_weixinhao"], .name');
    const snEl = li.querySelector('p.txt-info, .txt-info, p');
    push(href, title, snEl ? snEl.innerText : '', accountEl ? accountEl.innerText : '');
  });

  // Fallback: any article-ish links
  if (out.length < 2) {
    document.querySelectorAll('a[href*="mp.weixin.qq.com"], a[href*="link?url="], a[uigs="article_title"]').forEach(a => {
      const href = a.href || '';
      const title = (a.innerText || a.getAttribute('title') || '').trim();
      if (title.length < 4) return;
      push(href, title, '', '');
    });
  }

  // Captcha / empty page hint
  if (out.length === 0) {
    const body = (document.body && document.body.innerText) || '';
    if (/验证码|antispider|captcha|请输入验证|访问过于频繁/i.test(body)) {
      return [{url: location.href, title: '[sogou-weixin captcha/block]', snippet: body.slice(0, 200), source: 'sogou-weixin'}];
    }
  }
  return out.slice(0, __MAX_RESULTS__);
}"""


def _short_query(query: str, max_chars: int, max_terms: int) -> str:
    """Keep a social search query short without introducing a new topic."""
    normalized = " ".join(query.split())
    if len(normalized) <= max_chars:
        return normalized

    # Preserve quoted phrases, Latin words, and Chinese runs before falling back
    # to a character slice. This is deliberately extractive: compression must
    # never replace the user's subject with a hard-coded domain.
    terms = re.findall(
        r'"[^"\n]+"|\'[^\'\n]+\'|[A-Za-z0-9][A-Za-z0-9_+#.\-/]*|[\u4e00-\u9fff]{2,}',
        normalized,
    )
    selected: list[str] = []
    seen: set[str] = set()
    for term in terms:
        term = term.strip('"\'')
        if not term or term in seen:
            continue
        seen.add(term)
        selected.append(term)
        if len(selected) >= max_terms:
            break

    compressed = " ".join(selected)
    return (compressed or normalized[:max_chars])[:max_chars]


def compress_query_for_site(site_key: str, query: str) -> str:
    """Shorten a query to what the target engine can actually match.

    Every site is now budgeted and scrubbed of planner vocabulary. Google and
    Reddit used to be exempt, so a long planner-built brief reached them
    verbatim and their AND-ish semantics returned little or nothing — in the
    one measurable case Reddit returned zero hits while the force-truncated
    Chinese plane returned the most results.
    """
    q = " ".join(query.split())
    # Per-site budgets: social/WeChat search boxes tolerate fewer terms.
    if site_key in ("sogou-weixin", "weixin", "sogou"):
        max_terms, max_chars = 4, 30
    elif site_key in ("x", "twitter"):
        max_terms, max_chars = 4, 60
    else:
        max_terms, max_chars = MAX_QUERY_TERMS, 0

    try:
        budgeted = enforce_query_budget(q, max_terms)
    except ValueError:
        # Never emit an empty query: fall back to the extractive short form.
        budgeted = _short_query(q, max_chars=max_chars or 120, max_terms=max_terms)
    if max_chars and len(budgeted) > max_chars:
        # Drop whole trailing terms rather than slicing mid-word.
        terms = budgeted.split()
        while len(terms) > 1 and len(" ".join(terms)) > max_chars:
            terms.pop()
        budgeted = " ".join(terms)[:max_chars]
    return budgeted


def search_site(
    lane: str,
    site: str,
    query: str,
    wait_ms: int = 8000,
    max_results: int = DEFAULT_MAX_RESULTS,
    pages: int = 1,
) -> list[dict]:
    site_key = site.lower().replace("_", "-")
    search_q = compress_query_for_site(site_key, query)
    q = urllib.parse.quote_plus(search_q)
    page_urls: list[str] = []
    if site_key == "google":
        per_page = min(20, max(10, max_results))
        for page in range(max(1, pages)):
            page_urls.append(
                f"https://www.google.com/search?q={q}&hl=en&num={per_page}&start={page * per_page}"
            )
        js = GOOGLE_JS
        wait_ms = max(wait_ms, 8000)
    elif site_key == "reddit":
        page_urls.append(f"https://www.reddit.com/search/?q={q}&type=link&sort=relevance")
        js = REDDIT_JS
        wait_ms = max(wait_ms, 8000)
    elif site_key in ("x", "twitter"):
        page_urls.append(f"https://x.com/search?q={q}&src=typed_query&f=live")
        js = X_JS
        wait_ms = max(wait_ms, 12000)
        site_key = "x"
    elif site_key in ("sogou-weixin", "weixin", "weixin.sogou", "sogou_weixin", "sogou"):
        # type=2 = 文章；官网入口 https://weixin.sogou.com/
        for page in range(max(1, pages)):
            suffix = f"&page={page + 1}" if page else ""
            page_urls.append(
                f"https://weixin.sogou.com/weixin?type=2&s_from=input&query={q}&ie=utf8{suffix}"
            )
        js = SOGOU_WEIXIN_JS
        wait_ms = max(wait_ms, 10000)
        site_key = "sogou-weixin"
    else:
        raise ValueError(
            f"unknown site: {site} (use google,reddit,x,sogou-weixin)"
        )

    js = js.replace("__MAX_RESULTS__", str(max(1, int(max_results))))
    collected: list[dict] = []
    seen: set[str] = set()
    for page_url in page_urls:
        print(f"[{site_key}] query={search_q!r} url={page_url[:100]}...", file=sys.stderr)
        cdp("navigate", "--lane", lane, page_url, timeout=90)
        try:
            cdp("wait", "--lane", lane, "--load", "complete", "--timeout", str(wait_ms), timeout=max(30, wait_ms // 1000 + 15))
        except Exception:
            time.sleep(3)
        time.sleep(1.8)
        out = cdp("evaluate", "--lane", lane, "--fn", js, timeout=60)
        items = extract_json_from_eval(out)
        if not isinstance(items, list):
            items = []
        fresh = 0
        for it in items:
            if not isinstance(it, dict) or not it.get("url"):
                continue
            url = str(it["url"]).split("#", 1)[0]
            if url in seen:
                continue
            seen.add(url)
            it.setdefault("source", site_key)
            it["query"] = search_q
            it["seed_query"] = query
            collected.append(it)
            fresh += 1
        # A page that adds nothing new means paging has bottomed out.
        if fresh == 0:
            break
        if len(collected) >= max_results:
            break
    return collected[:max_results]


def main() -> int:
    ap = argparse.ArgumentParser(description="Browser SERP search via browser-mcp")
    ap.add_argument("query")
    ap.add_argument(
        "--sites",
        default="google,reddit,x,sogou-weixin",
        help="comma list: google,reddit,x,sogou-weixin (weixin.sogou.com)",
    )
    ap.add_argument("--lane", default=DEFAULT_LANE)
    ap.add_argument("--headless", action="store_true")
    ap.add_argument(
        "--max-results-per-site",
        type=int,
        default=DEFAULT_MAX_RESULTS,
        help="results kept per site; reading wide is what makes term mining possible",
    )
    ap.add_argument(
        "--pages",
        type=int,
        default=1,
        help="SERP pages to walk where the engine supports paging (google, sogou-weixin)",
    )
    ap.add_argument("--output", "-o", help="write JSON path")
    ap.add_argument("--skip-start", action="store_true")
    args = ap.parse_args()

    if not args.skip_start:
        ensure_lane(args.lane, headless=args.headless)

    all_items: list[dict] = []
    for site in [s.strip() for s in args.sites.split(",") if s.strip()]:
        try:
            items = search_site(
                args.lane,
                site,
                args.query,
                max_results=args.max_results_per_site,
                pages=args.pages,
            )
            print(f"[{site}] {len(items)} hits", file=sys.stderr)
            all_items.extend(items)
        except Exception as e:
            print(f"[{site}] FAIL {type(e).__name__}: {e}", file=sys.stderr)

    session = SESSIONS.pop(args.lane, None)
    if session:
        try:
            browser_call("browser_close", {"session_id": session}, timeout=30)
        except Exception as exc:
            print(f"[browser-close] {type(exc).__name__}", file=sys.stderr)

    if args.output:
        Path(args.output).write_text(json.dumps(all_items, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"wrote {args.output}", file=sys.stderr)
    else:
        print(json.dumps(all_items, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
