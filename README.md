# Deep Research

多源检索、语义查询规划与可审计证据包。融合 Smart Search、Tavily、Exa、
Google / Reddit / X / 搜狗微信浏览器搜索，以及 last30days 近期社区搜索。
可选 GPT Researcher 合成和飞书发布。Python 3.10+，核心无第三方 Python 依赖。

## 快速开始

```bash
git clone https://github.com/wenhanweime/deep-research.git
cd deep-research
python3 -m venv .venv
source .venv/bin/activate
python scripts/setup.py init
python scripts/setup.py doctor --tools tavily
python scripts/setup.py doctor --tools tavily --online
python scripts/deep_research.py "研究问题" --planes smart --planner legacy --rounds 1 --no-gptr -o outputs/first-run
```

上面是只需 Tavily Key 的最小连通性示例。`smart` 平面包含直接 Tavily/Exa API，
不要求一定安装 Smart Search CLI。`--planner legacy` 用于首次验证；正式研究建议
使用 `--planner agent`（由当前 AI agent 提供计划）或 `--planner auto`（配置模型 API）。

**[完整安装与逐工具配置引导 → docs/SETUP.md](docs/SETUP.md)**

## 配置与隐私

- 交互向导用隐藏输入收集 Key，保存到仓库外 `~/.config/deep-research/.env`，权限 `0600`。
- `config/.env.example` 只有空值与公共默认地址；不读取作者的 GPTR、Smart Search 全局配置。
- `DEEP_RESEARCH_CONFIG_DIR` 可更换配置目录；`DEEP_RESEARCH_ENV_FILE` 可指定外部文件。
- 优先级：进程环境变量 > 外部 `.env` > 默认值。不会执行 `.env` 中的命令或变量展开。
- 输出、浏览器登录态和第三方工具认证文件不进入 Git。飞书发布和通知均为可选显式动作。
- 本地已有版本保持不变；不要复制旧研究输出或整个个人配置目录到仓库。

## 研究流程

```text
研究问题 → 语义规划 → 多源搜索 → 去重与证据审阅 → 下一轮搜索
                                  ↓
                    manifest.json / sources.jsonl / summary.md
                                  ↓
                     report.md（证据清单或可选模型合成）
```

默认启用 `smart,browser,last30days`；首次使用可用 `--planes smart` 缩小范围。
未安装、未登录或请求失败的来源可能缺失，不能把零结果解释为没有相关信息。
模型合成是草稿，需要核查来源；`--no-gptr` 仅输出结构化证据摘要。

`--planner agent` 会以退出码 3 暂停，并生成 `planner_request.json`。由 AI agent 阅读
[查询规划协议](references/query-planning.md)，生成计划后通过 `--query-plan` 恢复；
这是工作流中的计划交接。退出码 4 表示来源失败。`query_budget` / `rounds_exhausted`
表示预算耗尽，不能宣称已完整覆盖主题。

## 可选集成

- 浏览器服务源码：[tools/browser-mcp](tools/browser-mcp/README.md)。Node 22+、Chrome，所有页面操作经托管 HTTP 服务。
- 近期社区搜索：外部 last30days 项目，安装方式、平台 Key 与限制见配置引导。
- GPT Researcher：`pip install -r requirements-gptr.txt`；聊天与 embedding API 均需可用。原机特有的 embedding 补丁未带入。
- 飞书：配置 lark-cli 后手动执行 `python scripts/publish_feishu.py --report outputs/first-run/report.md --title "研究标题"`。
  默认不发送 IM；需要通知时明确加 `--notify`，目标来自参数、配置或当前认证用户。

## 开发与验证

```bash
python -m unittest discover -s tests -v
python scripts/check_public.py
cd tools/browser-mcp
npm ci
npm test
```

测试使用模拟请求和假浏览器，不需要真实 Key。`doctor --online` 会发起真实请求，
可能产生 API 费用；离线 doctor 只检查配置，不保证凭据有效。

## 开源范围

本仓库包含 Deep Research 编排、原有回归测试，以及托管浏览器服务源码；
不包含个人 Key、账户、登录态、历史研究成果或其他项目的 Git 历史。
Smart Search、last30days、GPT Researcher、lark-cli 是独立依赖，遵循各自许可。
详见 [THIRD_PARTY.md](THIRD_PARTY.md)。本项目采用 [MIT License](LICENSE)。
