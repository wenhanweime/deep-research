# 四路搜索融合架构

## 四层平面

```
                    ┌─────────────────────────────┐
                    │    Deep Research pipeline   │
                    └──────────────┬──────────────┘
           ┌───────────────────────┼───────────────────────┐
           ▼                       ▼                       ▼
   ┌───────────────┐      ┌────────────────┐      ┌──────────────────┐
   │ Plane A       │      │ Plane B        │      │ Plane C          │
   │ Smart Search  │      │ Direct API     │      │ Chrome Daemon    │
   │ CLI           │      │ (Tavily/Exa)   │      │ Google/Reddit/X  │
   └───────┬───────┘      └───────┬────────┘      └────────┬─────────┘
           │                      │                        │
           └──────────────────────┼────────────────────────┘
                                  ▼
                         sources.jsonl (dedupe)
                                  │
                    ┌─────────────┴─────────────┐
                    ▼                           ▼
            gptr-docs/*.md              report.md (GPTR hybrid)
```

图中的 A–C 是原有搜索平面；Plane D `last30days` 与它们并行执行，并在去重前写入同一 `sources.jsonl`。默认使用 quick 模式，任何单个平台失败都只记录到 `last30days_status.json`，不阻断其他平面。

| Plane | 工具 | 强项 | 弱项 |
|-------|------|------|------|
| **A Smart Search** | `smart-search search/exa` | 多 provider 路由、快、可落盘 | 登录墙/强反爬页弱 |
| **B Direct API** | Tavily / Exa key | 结构化 SERP、稳定 | 配额/费用 |
| **C Browser CDP** | `cdp_browser_daemon` lane=`cdp-browser-daemon` | Google/Reddit/X/**搜狗微信** 真页面、可登录态 | 慢、易被挑战、依赖 Chrome |
| **D last30days** | `last30days.py --emit=json` | Reddit/X/YouTube/TikTok/Instagram/HN/Polymarket 等近期信号与互动指标 | 只覆盖近期；部分来源需凭据；不能替代一手资料 |

### 搜狗微信 (weixin.sogou.com)

| 项 | 值 |
|----|-----|
| 入口 | https://weixin.sogou.com/ |
| 检索 URL | `https://weixin.sogou.com/weixin?type=2&query=<q>&ie=utf8`（type=2=文章） |
| skill 站点名 | `sogou-weixin`（别名：`weixin` / `sogou`） |
| 归一 plane | `browser:sogou-weixin` |
| 注意 | 常出验证码/反爬；链接多为搜狗跳转 `link?url=`，点开才到 `mp.weixin.qq.com` |

## 归一化字段

每条结果：

```json
{
  "url": "https://...",
  "title": "...",
  "snippet": "...",
  "source": "google|reddit|x|tavily|exa|...",
  "plane": "smart-search:search|browser:google|api:tavily|..."
}
```

## 合成策略

1. **Evidence-first**：先固定 evidence 目录，再写报告（可复现）。
2. **GPTR hybrid**：`DOC_PATH=gptr-docs` + `report_source=hybrid`，本地包为主、web retriever 为辅。
3. **Fallback**：GPTR 失败 → `summary.md` + sources 表的 evidence-only 报告。

## 何时开哪路

| 场景 | 建议 planes |
|------|-------------|
| 快速事实 / 新闻 | `smart,last30days`，last30days 使用 quick/best-effort |
| 默认深度研究 | `smart,browser,last30days` |
| 舆情 / 社区 / 讨论 | `smart,browser,last30days` |
| 登录态 / 动态页 | `browser` + 已登录 lane profile |
| 完整深度报告 | `smart,browser,last30days` + GPTR |

## 可移植配置

配置来自仓库外的 `~/.config/deep-research/.env` 或显式环境变量。
安装与逐工具验证见 [配置引导](../docs/SETUP.md)。浏览器托管服务源码随仓库提供；
Smart Search / last30days / GPT Researcher 是独立依赖。飞书发布可选。
