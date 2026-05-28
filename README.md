# dcache

[English](#english) | [中文](#中文)

<a id="english"></a>
## English

dcache is a small local helper for improving **DeepSeek** prompt-cache hit rate in opencode, Claude Code, and Codex CLI. It starts a Web report, installs managed hooks/commands, and can route model traffic through a local proxy so cache hits are measured from real DeepSeek responses.

It is not a general cache system for every model. The tests, reports, and defaults are tuned for DeepSeek cache behavior.

This project was inspired by the cache-stability idea in https://github.com/esengine/DeepSeek-Reasonix. dcache is a separate implementation.

## Tested impact

The effect is visible immediately in the latest verified workspace run:

| CLI route | Baseline cache hit ratio | With dcache / anchor |
| --- | ---: | ---: |
| Codex CLI + real DeepSeek V4 Flash | `0.1399` | `0.9921` hot case-first / `0.9921` cross-session first requests |
| opencode + real DeepSeek V4 Flash | `0.2098` | `0.9916` anchor hot requests |
| Claude Code + real DeepSeek Anthropic API | `0%` case-first | `100%` hot case-first / `100%` cross-session first requests |

Verification snapshot: `npm run test` passed 35 tests, and `npm run build` passed.

## Quick start

```bash
npm install
npm run build
npm install -g .
dcache serve --project /path/to/project
```

Open `http://127.0.0.1:48731`.

In the Web page, use the simple buttons:

- **Hook opencode / Claude / Codex**: install managed listeners and the manual `newanchor` helper.
- **Hook ... + connect API**: also route that CLI through the local proxy, so reports show real DeepSeek cache hits.
- **Uninstall ...**: remove only files marked as managed by dcache.

CLI examples:

```bash
dcache hook --project /path/to/project
dcache hook --target opencode --connect-api --project /path/to/project
dcache hook --target claude --connect-api --project /path/to/project
dcache hook --target codex --connect-api --project /path/to/project
dcache hook --target all --connect-api --project /path/to/project
dcache uninstall --target all --project /path/to/project
```

For Codex, dcache creates a `dcache` profile. Run Codex with that profile:

```bash
codex -p dcache -m deepseek-v4-flash
codex -p dcache -m deepseek-v4-flash exec "your prompt"
```

Set `DEEPSEEK_API_KEY` in your shell before using the connected route.

If the default ports are busy, `dcache serve` automatically picks free ports and prints the actual Web/proxy URLs.

## What it installs

- opencode plugin: `.opencode/plugins/dcache.js`
- Claude Code hook: `.claude/hooks/dcache.mjs`
- Codex hook: `.codex/hooks/dcache.mjs`
- opencode/Claude `/newanchor` command and Codex `$newanchor` skill
- local data and logs under `.dcache/`
- for Codex only: `$CODEX_HOME/hooks.json` and `$CODEX_HOME/dcache.config.toml`

It does not overwrite user-owned files with the same path. Uninstall removes only dcache-managed files.

## Anchor

Anchor is **off by default**.

Turn it on when the project is small or stable and you expect many related conversations. It keeps stable project background at the front of requests so DeepSeek can reuse the prefix across sessions.

Tradeoffs:

- good for small/stable projects and repeated work;
- costs extra prompt tokens;
- stale anchor text can bias answers;
- never put secrets in anchor text;
- usually unnecessary for one-off prompts or fast-changing context.

Manual controls:

```text
/newanchor status
/newanchor on Stable facts about this repo that should stay at the front.
/newanchor off
/newanchor reset
```

Use `$newanchor` in Codex. The Web page has the same controls and shows the anchor change log.

dcache resets anchor generation for real context changes such as opencode `/new`, forks, Claude `/clear`, compact/resume-like Codex events, and project changes. A brand-new terminal window does not reset anchor just because the window is new.

## Reports

The Web report shows:

- DeepSeek cache hit ratio;
- recent model requests;
- opencode, Claude Code, and Codex status;
- anchor enabled/off state;
- anchor changes and reset history;
- warnings such as prefix drift or missing cache usage.

## Runtime differences and risks

- **opencode** gives the cleanest session/fork signals.
- **Claude Code** may send extra internal requests. For fair comparisons, dcache looks at case-first requests as well as totals.
- **Codex CLI** uses the OpenAI Responses API shape. dcache translates it to DeepSeek Chat Completions at the local proxy. Codex hook execution depends on the local Codex hooks feature/trust mode, so dcache also injects the anchor in the proxy path when anchor is enabled.
- **connect API** requires the sidecar to be running. If it is stopped, the connected CLI may fail model calls until you restart dcache or uninstall the route.
- Keep Web/API/proxy ports on localhost or a trusted network.

## Real comparison tests

The real tests use the same business prompts where possible:

- shared prompts: [`tests/dcache-real-cases.ts`](tests/dcache-real-cases.ts)
- opencode E2E: [`tests/dcache-local-opencode.test.ts`](tests/dcache-local-opencode.test.ts)
- Claude Code E2E: [`tests/dcache-local-claude.test.ts`](tests/dcache-local-claude.test.ts)
- Codex CLI E2E: [`tests/dcache-local-codex.test.ts`](tests/dcache-local-codex.test.ts)
- anchor behavior: [`tests/dcache-anchor.test.ts`](tests/dcache-anchor.test.ts)

The headline results are shown near the top under **Tested impact**. This section keeps the test files and reproduction commands together.

For Codex/opencode/Claude, the first anchored request may be a warm-up. The important cross-session signal is the next first request of a new case/session.

Optional real test commands:

```powershell
$env:OPENCODE_REAL_E2E="1"
$env:OPENCODE_REAL_MODEL="deepseek/deepseek-v4-flash"
npm run test:e2e:opencode

$env:CLAUDE_REAL_E2E="1"
$env:CLAUDE_REAL_MODEL="haiku"
npm run test:e2e:claude

$env:CODEX_REAL_E2E="1"
$env:CODEX_REAL_MODEL="deepseek-v4-flash"
npx vitest run tests/dcache-local-codex.test.ts --testNamePattern "real DeepSeek"
```

## Docker

```bash
docker compose up --build
```

The compose file uses `restart: unless-stopped`.

If host ports are occupied:

```bash
DCACHE_WEB_PORT=48732 DCACHE_PROXY_PORT=11489 docker compose up --build
```

## Platform

Target runtime: Node.js `>=22.18.0`. The project is designed for Windows, macOS, and Linux.

---

<a id="中文"></a>
## 中文

dcache 是一个本地小工具，专门优化 **DeepSeek** 的 prompt cache 命中率，面向 opencode、Claude Code 和 Codex CLI。它会启动 Web 报表，安装托管的 hook/命令，也可以把模型请求转到本地代理，从真实 DeepSeek 响应里统计缓存命中。

它不是所有模型通用的缓存系统；测试、报表和默认逻辑都围绕 DeepSeek 的缓存行为设计。

本项目参考了 https://github.com/esengine/DeepSeek-Reasonix 的缓存稳定思路，但实现是独立的。

## 测试效果一眼看

打开 README 先看效果：当前工作区最新验证里，dcache 能把真实 DeepSeek 请求的缓存命中率稳定拉到接近满命中。

| CLI 路由 | 不开插件 baseline | 使用 dcache / anchor 后 |
| --- | ---: | ---: |
| Codex CLI + 真实 DeepSeek V4 Flash | `0.1399` | `0.9921` hot case-first / `0.9921` 跨 session first requests |
| opencode + 真实 DeepSeek V4 Flash | `0.2098` | `0.9916` anchor 热请求 |
| Claude Code + 真实 DeepSeek Anthropic API | `0%` case-first | `100%` hot case-first / `100%` 跨 session first requests |

验证快照：`npm run test` 35 个测试通过，`npm run build` 通过。

## 快速开始

```bash
npm install
npm run build
npm install -g .
dcache serve --project /path/to/project
```

打开 `http://127.0.0.1:48731`。

Web 页面里直接点按钮：

- **Hook opencode / Claude / Codex**：安装监听和手动 `newanchor` 辅助命令。
- **Hook ... + connect API**：同时让该 CLI 走本地代理，报表才能显示真实 DeepSeek 缓存命中。
- **Uninstall ...**：只删除 dcache 托管标记的文件。

命令行例子：

```bash
dcache hook --project /path/to/project
dcache hook --target opencode --connect-api --project /path/to/project
dcache hook --target claude --connect-api --project /path/to/project
dcache hook --target codex --connect-api --project /path/to/project
dcache hook --target all --connect-api --project /path/to/project
dcache uninstall --target all --project /path/to/project
```

Codex 会生成 `dcache` profile，使用时这样启动：

```bash
codex -p dcache -m deepseek-v4-flash
codex -p dcache -m deepseek-v4-flash exec "你的 prompt"
```

使用 connect API 前，在 shell 里配置 `DEEPSEEK_API_KEY`。

默认端口被占用时，`dcache serve` 会自动换空闲端口，并打印实际 Web/proxy 地址。

## 会安装什么

- opencode 插件：`.opencode/plugins/dcache.js`
- Claude Code hook：`.claude/hooks/dcache.mjs`
- Codex hook：`.codex/hooks/dcache.mjs`
- opencode/Claude 的 `/newanchor` 命令，以及 Codex 的 `$newanchor` skill
- `.dcache/` 下的本地数据和日志
- 仅 Codex：`$CODEX_HOME/hooks.json` 和 `$CODEX_HOME/dcache.config.toml`

不会覆盖同路径的用户自有文件。卸载时只删除 dcache 托管的文件。

## Anchor

Anchor **默认关闭**。

适合在小项目、稳定项目、需要连续多轮相关对话时开启。它会把稳定项目背景放到请求前面，让 DeepSeek 更容易跨 session 复用前缀缓存。

取舍：

- 小而稳定的项目可以常开；
- 会增加 prompt token；
- 过期 anchor 会影响回答；
- 不要把密钥写进 anchor；
- 一次性短任务通常不需要。

手动控制：

```text
/newanchor status
/newanchor on 这个仓库长期稳定、应该放在前面的背景信息。
/newanchor off
/newanchor reset
```

Codex 里用 `$newanchor`。Web 页面也有同样按钮，并会展示 anchor 变动日志。

dcache 会在真实上下文变化时重置 anchor generation，例如 opencode `/new`、fork、Claude `/clear`、Codex compact/resume 类事件，以及项目切换。单纯新开一个终端窗口不会因为“新窗口”而重置。

## 报表

Web 报表会展示：

- DeepSeek 缓存命中率；
- 最近模型请求；
- opencode、Claude Code、Codex 状态；
- anchor 开关状态；
- anchor 变动和 reset 历史；
- prefix drift、缺少缓存用量等警告。

## 不同 CLI 的差异和风险

- **opencode** 的 session/fork 信号最清晰。
- **Claude Code** 可能会发送额外内部请求，所以公平对比时除了总量，也看每个用例的第一条请求。
- **Codex CLI** 使用 OpenAI Responses API 形态。dcache 会在本地代理里转换成 DeepSeek Chat Completions。Codex hook 是否执行受本地 hooks 功能和信任设置影响，所以 anchor 开启时，dcache 也会在代理路径注入 anchor，保证缓存优化不完全依赖 hook 是否触发。
- **connect API** 需要 sidecar 一直运行。如果 sidecar 停了，已连接到本地代理的 CLI 可能无法请求模型，直到重启 dcache 或卸载路由。
- Web/API/proxy 端口建议只暴露在本机或可信内网。

## 真实对比测试

真实测试尽量使用同一组业务 prompt：

- 共享用例：[`tests/dcache-real-cases.ts`](tests/dcache-real-cases.ts)
- opencode E2E：[`tests/dcache-local-opencode.test.ts`](tests/dcache-local-opencode.test.ts)
- Claude Code E2E：[`tests/dcache-local-claude.test.ts`](tests/dcache-local-claude.test.ts)
- Codex CLI E2E：[`tests/dcache-local-codex.test.ts`](tests/dcache-local-codex.test.ts)
- anchor 行为：[`tests/dcache-anchor.test.ts`](tests/dcache-anchor.test.ts)

前面的“测试效果一眼看”已经展示当前工作区最新验证结果；这里保留用例和复现命令。

Codex/opencode/Claude 的第一条 anchor 请求可能只是预热；更关键的是下一条新 case/session 的 first request。

可选真实测试命令：

```powershell
$env:OPENCODE_REAL_E2E="1"
$env:OPENCODE_REAL_MODEL="deepseek/deepseek-v4-flash"
npm run test:e2e:opencode

$env:CLAUDE_REAL_E2E="1"
$env:CLAUDE_REAL_MODEL="haiku"
npm run test:e2e:claude

$env:CODEX_REAL_E2E="1"
$env:CODEX_REAL_MODEL="deepseek-v4-flash"
npx vitest run tests/dcache-local-codex.test.ts --testNamePattern "real DeepSeek"
```

## Docker

```bash
docker compose up --build
```

Compose 使用 `restart: unless-stopped`。

宿主机端口被占用时：

```bash
DCACHE_WEB_PORT=48732 DCACHE_PROXY_PORT=11489 docker compose up --build
```

## 平台

目标运行时：Node.js `>=22.18.0`。项目面向 Windows、macOS 和 Linux。
