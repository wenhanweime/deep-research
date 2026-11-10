# 首次配置与逐项验收

## 1. 环境与配置文件

Python 3.10+、Git。Smart Search 需要 Node 18+，捆绑浏览器服务需要 Node 22+。
建议用虚拟环境，不依赖 Homebrew 或作者的 Python 路径：

```bash
python3 -m venv .venv
source .venv/bin/activate
python scripts/setup.py init
```

向导逐项询问启用哪些工具；Key/Token/密码隐藏输入，空输入保留已有值。
非交互模式：`python scripts/setup.py init --non-interactive`，随后用编辑器填写
`~/.config/deep-research/.env`。不要用带 Key 的命令行参数，以免保存在 shell 历史。
自定义目录可在命令前设置 `DEEP_RESEARCH_CONFIG_DIR=/absolute/private/directory`。
外部文件不会自动提交，也不会自动读取旧 GPTR 或其他个人工具的配置。

## 2. 工具清单

| 工具 | 需要填写 | 其他准备 | 验收 |
| --- | --- | --- | --- |
| Smart Search | `XAI_API_KEY` + `XAI_MODEL`，或兼容服务 URL/Key/Model 三项 | 安装 CLI；兼容模型必须支持检索 | `doctor --tools smart --online` |
| Tavily | `TAVILY_API_KEY` | 账户有可用额度 | `doctor --tools tavily --online` |
| Exa | `EXA_API_KEY` | 账户有可用额度 | `doctor --tools exa --online` |
| 语义规划模型 | `DEEP_RESEARCH_PLANNER_API_KEY` / `MODEL` / `BASE_URL` | Chat Completions 兼容模型；agent 模式免 Key | `doctor --tools planner --online` |
| 浏览器四站点 | 无 API Key | 服务、Chrome、按需登录或处理验证码 | health + 各站点真实搜索 |
| last30days | 按平台选择下表 Key | 安装其脚本，填写绝对路径 | `doctor --tools last30days --online` + 状态文件 |
| GPT Researcher | `OPENAI_API_KEY`、`FAST_LLM`、`SMART_LLM` | 安装 Python 依赖、embedding API 权限 | 安装检查 + 实际合成 |
| 飞书 | lark-cli 独立认证；可填通知目标 | 用户授权 Wiki 和文档权限 | auth 检查 + 显式发布 |

所有 doctor 命令均以 `python scripts/setup.py` 开头。无 `--online` 时只做静态检查；
缺项或失败返回 1。`--tools` 只选择准备启用的工具；不加此参数检查全部工具。

## smart

```bash
npm install -g @konbakuyomu/smart-search@0.1.13
```

在外部 `.env` 填写 `XAI_API_KEY`、`XAI_MODEL`；`XAI_API_URL` 默认是官方 HTTPS 地址。
模型名以自己账户实际支持的为准。兼容服务改填 `OPENAI_COMPATIBLE_API_URL`、
`OPENAI_COMPATIBLE_API_KEY`、`OPENAI_COMPATIBLE_MODEL`，仅普通聊天模型未必支持搜索。
Deep Research 通过环境变量向 CLI 传配置，避免改写你已有的全局配置。
`EXA_API_KEY` 同时用于 Smart Search 的 `exa-search`。仅配置兼容聊天 Key 不代表 Exa 可用。

Smart Search 本身还提供 Context7、Zhipu、Firecrawl 等命令；本项目只调用 `search` 与
`exa-search`，其他命令不属于本项目启用的检索源。若单独使用，应按其上游说明配置。

## tavily

在 Tavily 账户取得 API Key，填入 `TAVILY_API_KEY`，运行在线 doctor。
即使未安装 Smart Search 也会直接调用 Tavily。401/403 检查 Key/权限，429 检查额度。

## exa

从 Exa 账户取得 Key，填 `EXA_API_KEY`。无 Smart Search 时直接调用 Exa；
有 CLI 时使用其 `exa-search`。在线 doctor 单独验证 Exa API，不会把其他来源成功当成 Exa 成功。

## planner

正式独立 CLI 研究用 `--planner auto`，填写 `DEEP_RESEARCH_PLANNER_*` 三项。
兼容端点应包含 `/v1`（如服务要求），支持 `/chat/completions` 与 JSON 指令输出。
已有 agent 可以用默认 `--planner agent`，无需模型 Key；按 `planner_request.json`
生成计划，再用 `--query-plan /path/plan.json` 恢复。详见查询规划协议。
在线 doctor 仅验证聊天响应，计划结构仍由执行期校验器验证。

## browser

已安装 browser-mcp 的用户可以复用服务；否则使用本仓库携带的实现：

```bash
cd tools/browser-mcp
npm ci
npm start
```

保持这个终端运行。在另一终端从仓库根目录执行：

```bash
node tools/browser-mcp/cli.mjs health
```

把外部 `.env` 的 `DEEP_RESEARCH_BROWSER_BIN` 设为 `tools/browser-mcp/cli.mjs` 的**绝对路径**。
安装 Chrome；非 macOS 系统或路径不同时，在**启动服务的终端**设
`CDP_BROWSER_CHROME` 为 Chrome 可执行文件路径。不能用 profile label 保存密码或 token。
默认共享稳定 profile；有明确隔离需求才使用稳定 profile ID。
所有网页动作通过 browser-mcp HTTP facade；不要直接调用捆绑 daemon 或 raw CDP。

在 agent 环境遵循其浏览器控制规则。以下命令供配置用户手动逐站验收：

```bash
python scripts/browser_search.py "Python" --sites google -o outputs/google.json
python scripts/browser_search.py "Python" --sites reddit -o outputs/reddit.json
python scripts/browser_search.py "Python" --sites x -o outputs/x.json
python scripts/browser_search.py "人工智能" --sites sogou-weixin -o outputs/weixin.json
```

运行前 `mkdir -p outputs`。Google/搜狗可能出现验证码；X/Reddit 可能要求登录。
由用户在托管 Chrome 窗口完成，随后重试。health 成功只代表服务在线，不能证明
四个站点都已登录或搜索有结果。不要自动绕过验证码。

## last30days

独立依赖，不捆绑用户本机的修改版，也不包含其认证文件：

```bash
mkdir -p vendor
git clone https://github.com/mvanhorn/last30days-skill.git vendor/last30days
```

默认寻找 `vendor/last30days/scripts/last30days.py`；也可通过外部配置
`DEEP_RESEARCH_LAST30_SCRIPT` 指向已有安装的绝对路径。上游随版本可能变化，
升级后重新验收；如需可重复部署，固定自己验证过的 commit。

| 平台 | 准备 |
| --- | --- |
| Reddit / TikTok / Instagram | `SCRAPECREATORS_API_KEY`；部分旧版本提供 `APIFY_API_TOKEN` 备用，以安装版本说明为准 |
| X | `XAI_API_KEY`，或上游支持的已登录 Bird；推荐 API Key，避免复制浏览器 cookie |
| YouTube | 安装 `yt-dlp`：`python -m pip install yt-dlp`；公开内容通常无需 API Key，字幕不保证存在 |
| Hacker News / Polymarket | 公开 API 通常免 Key，需要可访问网络 |
| Bluesky | `BSKY_HANDLE` 与 `BSKY_APP_PASSWORD`（使用 app password） |
| Truth Social | `TRUTHSOCIAL_TOKEN`，从用户自己授权的账户取得，不提交 Git |
| 可选 Web 搜索 | 按上游支持填写 `OPENROUTER_API_KEY`、`PARALLEL_API_KEY` 或 `BRAVE_API_KEY` |

Key 可填在同一份外部 `.env`，由 Deep Research 传给子进程；不需要复制到仓库。
在线 doctor 验证是否至少收到一个结果，**不保证所有平台成功**。
实际研究后逐项查看 `last30days_status.json` 的 `counts` 与 `errors`，记录未配置、
限流、登录失败和零命中来源。上游新增来源的前置条件需同时参考其文档。

## gptr

```bash
python -m pip install -r requirements-gptr.txt
```

填写 `OPENAI_API_KEY`、`OPENAI_BASE_URL`，以及 `FAST_LLM`、`SMART_LLM`（上游格式如
`openai:<model-name>`）。默认 `EMBEDDING=openai:text-embedding-3-small`，需要相应接口权限。
运行一次不带 `--no-gptr` 的研究；检查 `gptr_stderr.log` 与实际报告。
原机定制的 HashEmbeddings 补丁不在开源版中，兼容端点必须支持所选 embeddings。
安装检查不等于模型合成已验证；合成失败会保留证据摘要并在日志中说明。

## feishu

飞书不是检索必选依赖。按 lark-cli 官方安装说明配置应用并进行用户认证，
允许 Wiki 节点创建/读取、知识空间读取与文档写入。然后检查：

```bash
lark-cli auth status --json
python scripts/publish_feishu.py --report outputs/first-run/report.md --title "研究标题"
```

发布脚本创建新 Wiki 文档，默认不发消息。明确需要通知才加 `--notify`；通知目标
来自 `--notify-user-id`、外部 `FEISHU_RESEARCH_NOTIFY_USER_ID` 或当前认证用户；
群通知用 `--notify-chat-id`。需要 bot 发消息权限与相应可见关系。无内置个人 open_id。
不要将 lark-cli token/cookie 拷贝到仓库；无写权限时不能声称已发布。

## 3. 完整验收顺序

1. 运行向导，填自己启用的工具。
2. 离线 doctor 确认依赖与配置项。
3. 针对每个 API 运行 `doctor --online --tools ...`。
4. 浏览器逐站搜索；last30days 逐平台检查状态，不用一个成功掩盖其他失败。
5. 最后运行完整 research；检查证据来源分布、停止原因与可选合成日志。

不要将任何输出目录视为可公开内容。发布前检查：`python scripts/check_public.py`。
该检查是补充防线，不是所有密钥格式都能识别的保证。
