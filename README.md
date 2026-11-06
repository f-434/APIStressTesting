# LLM Stress Lab · 大模型 API 压测台

面向大模型 API 的并发压测与稳定性检测平台。Go 后端 + React 前端，单文件二进制部署，支持 OpenAI、Claude、Gemini 三种原生协议，兼容 New API / One API 中转站。

## 功能

- **三种原生协议**：OpenAI `/v1/chat/completions`、Claude `/v1/messages`、Gemini `/v1beta/models/{model}:generateContent`，也可强制使用 OpenAI 兼容格式；自动模式按模型名推断协议。
- **自动获取模型列表**：自动尝试 `/v1/models`、Anthropic 风格与 `/v1beta/models`，支持勾选多个模型顺序压测，也可手动添加模型 ID。
- **三种压测模式**：固定总请求数、按时长持续压测、阶梯并发（逐档提升并记录每档结果）。
- **完整请求参数**：System / User Prompt、`max_tokens`、`temperature`、`top_p`、流式开关、单请求超时。
- **流式指标**：SSE 解析 token 流，统计 TTFT（首 token 延迟）、总延迟、输出 token/s；非流式请求的 TTFT 等于总延迟。
- **错误闭环**：非 200 响应记录状态码、错误类型、完整错误信息与上游 request id（`x-oneapi-request-id` 等），并按类型聚合；停止测试时进行中的请求不会被误计为失败。
- **实时监控**：SSE 推送进度、成功率、QPS、P50/P95、TTFT、每秒吞吐、并发曲线、错误汇总与最近请求。
- **可视化报告**：模型对比、延迟分布、延迟时间线、吞吐、并发、状态码分布、错误汇总、逐请求明细（含 Request ID、错误详情、响应预览），支持分页与“仅失败”筛选。
- **报告导出**：一键导出独立 HTML（含过程数据表格，样式贴近排查报告）或 JSON。
- **纯本地**：报告仅存于内存，密钥只用于请求目标接口，报告中的密钥自动打码。

## 快速开始

### 方式一：构建单文件二进制

Windows:

```powershell
./build.ps1
./llm-stress-lab.exe -addr 127.0.0.1:8080
```

Linux / macOS:

```bash
./build.sh
./llm-stress-lab -addr 127.0.0.1:8080
```

打开 <http://127.0.0.1:8080>。

构建脚本会先安装前端依赖、构建 React 到 `backend/web`，再把前端资源嵌入 Go 二进制。

### 方式二：开发模式

终端 1（后端）：

```bash
cd backend
go run . -addr 127.0.0.1:8080
```

终端 2（前端）：

```bash
cd frontend
npm install
npm run dev
```

打开 <http://127.0.0.1:5173>，Vite 会把 `/api` 代理到 `127.0.0.1:8080`。

## 使用流程

1. 填写接口根地址（如 `https://your-relay.example.com`，带不带 `/v1` 均可）和 API Key。
2. 选择协议（默认自动），点击「获取模型列表」。
3. 勾选一个或多个模型；列表获取失败时可手动添加模型 ID。
4. 填写 Prompt 与请求参数。
5. 选择负载模式并设置请求数 / 时长 / 并发。
6. 开始压测，实时查看指标；结束后自动进入报告页。

## 指标说明

| 指标 | 说明 |
| --- | --- |
| 成功率 | `HTTP 200 请求数 / 已完成请求数` |
| QPS | 成功请求数 / 执行耗时 |
| 延迟 P50 / P95 / P99 | 请求从发出到响应体读取完成的耗时分位数 |
| TTFT | 流式响应首 token 到达时间；非流式为总延迟 |
| 输出速度 | `completion_tokens / 生成阶段耗时`（流式扣除 TTFT） |
| Token 来源 | 优先使用接口返回的 `usage`；缺失时按文本长度估算并标记 |
| 取消数 | 固定请求数模式下，因手动停止而未执行的请求数 |

## 兼容性

- **New API / One API**：`/v1/chat/completions`、`/v1/messages`、`/v1/models`、`/v1beta/models/...`。
- **OpenAI**：`Authorization: Bearer`。
- **Anthropic**：`x-api-key` + `anthropic-version`，同时附带 Bearer 以兼容中转站。
- **Gemini**：`x-goog-api-key`（中转站），原生 Google 端点同样适用。
- 推理模型（`o1*` / `o3*` / `o4*` / `gpt-5*`）自动改用 `max_completion_tokens` 并省略采样参数。

## 本地验证工具

仓库自带模拟中转站与冒烟测试，无需真实密钥即可验证整条链路：

```bash
node dev/mock-server.mjs 9099          # 模拟 OpenAI / Claude / Gemini
./llm-stress-lab.exe -addr 127.0.0.1:8099
node dev/smoke-test.mjs                # 默认连接 8099 + 9099
```

模拟服务密钥为 `sk-test`；模型 `broken-model` 会固定返回 500，其余 OpenAI 路由有 8% 概率返回 429，用于验证错误记录。

截图工具（需本机 Chrome）：

```bash
node --experimental-websocket dev/screenshot.mjs <url> <out.png> [width] [maxHeight]
```

## 限制

- 报告仅保存在内存中，重启服务后清空（按需求采用内存存储）。
- 单个模型最多保留 20000 条请求明细用于展示；统计指标基于全部请求计算。
- 单次测试最多执行 100000 条请求；固定模式一次配置最多 30000 条。
- 并发上限 100，单请求超时 1 - 600 秒，压测时长 5 - 3600 秒。
- 请仅对已获授权的接口进行压测，注意目标服务的限流策略。

## 目录结构

```
backend/
  main.go                  # HTTP 入口，嵌入前端资源
  internal/bench/          # 压测核心
    types.go               # 配置、结果、报告结构
    probe.go               # 协议请求、SSE 解析、模型发现
    runner.go              # 固定 / 时长 / 阶梯并发执行器
    stats.go               # 分位数、直方图、时间线、聚合
    test.go                # 测试状态、实时快照、报告、内存存储
  internal/server/         # REST API + SSE + SPA 托管
  web/                     # 构建后的前端资源（由 Vite 输出）
frontend/
  src/components/          # 配置、实时监控、报告、图表、历史
  src/exportHtml.ts        # 独立 HTML 报告生成
dev/                       # 模拟服务与冒烟测试
```
