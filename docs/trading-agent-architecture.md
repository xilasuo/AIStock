# 交易 Agent 架构文档

本文件描述 `trading_agent/` 模块的整体架构、分层职责与数据流，是 `trading_agent/README.md` 中「选票 → 操作 → 回测 → 优化策略」闭环的权威设计说明。

> 定位：本模块是**分析 / 回测 / 模拟**框架，结果基于历史公开数据，不构成投资建议，不做真实资金下单。

---

## 1. 设计目标

提供一个可在本地 PC 直接运行的轻量量化闭环：

1. **零连接启动**：数据底座走真实 A 股公开接口（腾讯财经估值 + 东财前复权日线），免 key、无需接入任何连接器即可跑通。
2. **四步闭环**：选票 → 操作（信号）→ 回测 → 优化策略，由引擎编排。
3. **跨机器联动**：本地 PC 跑完闭环后，把结果推送（HTTP POST）到远程云端的 AIStock 服务（`/api/strategy-scan`），前端「策略扫描」视图读取展示。
4. **WorkBuddy 当中枢**：数据获取、执行回写、提醒推送均由 **WorkBuddy 中枢**负责（调用 westock-mcp / tdx-connector / 企业微信）。trading_agent 只做**纯计算引擎**，数据通过可注入的 `DataProvider` 接口传入，自身不直连任何 MCP。

---

## 2. 分层架构（WorkBuddy 中枢模式）

```
┌──────────────────────────── 中枢：WorkBuddy（本 Agent） ────────────────────────────┐
│  调用 westock-mcp（行情/估值）· tdx-connector（K线/回写）· 企业微信（推送）           │
│   hub.py 编排：取数 → 注入引擎 → 回写 → 推送                                        │
└───────────────┬───────────────────────────────────────────────┬───────────────────┘
                │ 注入 (klines, quotes, hot)                      │ 回写 / 推送 指令
                ▼                                                 ▼
┌───────────────────────────────────────────┐      ┌──────────────────────────────────┐
│  trading_agent（纯计算引擎 + HTTP 调度）     │      │  云端 AIStock（Docker 部署）       │
│   core/loop.py        四步闭环编排           │      │   /api/strategy-scan  落盘展示     │
│   strategy/screener   选票（多因子）         │      │   /api/feedback       反馈入口     │
│   strategy/signals    操作（信号）           │      └──────────────────────────────────┘
│   backtest/*          回测引擎 + 指标        │
│   optimization/*      优化策略（网格）       │
│   data/provider.py    DataProvider 接口      │
│     · StaticProvider  中枢注入数据           │
│     · TencentEastMoneyProvider 直连兜底      │
│   agent_server.py     /run 接受 prefetched   │
│   feedback_store.py   反馈存储（闭环）       │
└───────────────────────────────────────────┘

数据底座（兜底，零配置可用）：腾讯 / 东财直连（provider 默认实现）+ 同花顺热点候选池。
connectors/ 作为「独立直连模式」备选：trading_agent 自行调 MCP（用于无中枢的独立部署）。
```

> 默认且推荐：**WorkBuddy 当中枢**。中枢取数后注入引擎，引擎完全不知道连接器存在；
> 真实连接器（westock-mcp / tdx-connector）在 WorkBuddy 连接器面板 trust 后即可由中枢调用。
> 未配置中枢时，引擎回退腾讯/东财直连，保持零连接可跑。

---

## 3. 业务层职责

### 3.1 选票 — `strategy/screener.py`
多因子打分选股，因子与权重集中在 `config.ScreenerConfig`：

| 因子 | 含义 | 默认权重 |
|------|------|----------|
| 动量 `w_momentum` | 回看 `momentum_window`（默认 20 交易日）的动量 | 0.50 |
| 估值 `w_value` | 盈利收益率（PE 倒数） | 0.30 |
| 流动性 `w_liquidity` | 换手率 | 0.20 |

过滤条件：`min_turnover_pct`（换手率下限，默认 0.15%）、`max_pe_ttm`（默认 200）、`max_pb`（默认 20）。选出 `top_n`（默认 8）只标的。

### 3.2 操作 — `strategy/signals.py`
基于均线的买卖信号：

- 快线 `fast_ma`（默认 5）/ 慢线 `slow_ma`（默认 20）均线交叉。
- 可选突破过滤 `use_breakout_filter`：要求突破 `breakout_window`（默认 20）日新高才买入。
- 止损 `stop_loss_pct`（默认 -8%，基于买入价）。
- `max_positions`（默认 8，与选股 `top_n` 对齐）。

### 3.3 回测 — `backtest/engine.py` + `backtest/metrics.py`
对每只标的按信号做回测，产出权益曲线 `equity` 与指标 `metrics`（收益率、夏普、回撤等）。回测成本由 `config.BacktestConfig` 控制：初始资金（仅展示量级）、单边手续费 `fee_rate`（万三）、滑点 `slippage`。

### 3.4 优化策略 — `optimization/optimizer.py`
网格搜索最优 `fast_ma` / `slow_ma` 组合，目标指标 `metric`（默认 `sharpe`）。网格来自 `config.OptimConfig`：`fast_ma_grid=[3,5,8,10]`、`slow_ma_grid=[15,20,30,60]`；`rounds` 为内循环迭代轮数。可用 `--no-optim` 跳过。

---

## 4. 中枢层

### 4.1 闭环编排 — `core/loop.py`
`run(cfg)` 编排四步流水线：

1. `universe.get_universe(cfg)` 取候选池 → `screener.screen` 选票。
2. `provider.fetch_kline` 拉取已选标的历史 K 线 → `signals.generate_signals` 生成当前参数信号 → `engine.backtest` 跑基准回测。
3. （若 `optim.enabled`）`optimizer.optimize` 网格搜索，挑出最优信号与回测。
4. 用最终信号重算信号条数与最终回测，组装 `result` 字典（含 `meta` / `selected` / `base` / `optimized` / `final`）。

### 4.2 桥接连接器 — `bridge.py` + `connectors/`

`ConnectorHub` 把上层策略与底层数据源 / 执行通道解耦，连接器是否启用完全由 `config.ConnectorsConfig` 决定（填了端点即启用，留空退回直连）：

- **数据路由**：`request_kline` 优先 `TdxConnector`，备选 `WestockConnector`，再回退 `EastMoneyConnector` 直连；`request_quote` 优先 `WestockConnector`，再回退 `TencentConnector` 直连。
- **执行回写**：`writeback_signals(signals, dry_run=True)` 把信号经 `TdxConnector` 的下单接口写回通达信（默认 dry-run 安全，配置 `enable_writeback=True` 且 `dry_run=False` 才发真实委托）。
- **提醒推送**：`notify(scan_result)` 经 `WeComPusher`（企业微信 Webhook）推送选股结果。

连接器实现位于 `connectors/`：
- `connectors/mcp.py`：MCP over Streamable HTTP 通用客户端（`MCPHTTPClient` + `MCPConnector` 基类），自动 `tools/list` 发现、按 `tool_map` 映射工具名，本地端点 bypass 代理。
- `connectors/westock.py`：`WestockConnector`（腾讯自选股 westock-mcp，数据查询为主）。
- `connectors/tdx.py`：`TdxConnector`（通达信 tdx-connector，行情 + 条件选股 + 交易接口/执行回写）。
- `connectors/push.py`：`WeComPusher`（企业微信群机器人 Markdown 推送）。

### 4.3 用户反馈闭环 — `feedback_store.py` + `app/api/feedback`

对应架构图「用户 → 本项目 → 优化策略」：

1. 前端「策略扫描」页对每只标的点「有效 / 无效」→ `POST /api/feedback`（云端 AIStock 存 `strategy_feedback` 表）。
2. trading_agent 本地亦可通过 `POST /feedback`（Agent 服务）或 `feedback_store.save_feedback` 落盘 `feedback.jsonl`。
3. `optimization/optimizer.py` 的 `apply_feedback_adjustment` 读取反馈汇总，正面占比高则上调动量权重、放宽止损；占比低则偏价值/流动性、收紧止损。**形成「用户反馈 → 优化策略」闭环。**

### 4.4 Agent 调度入口 — `agent_server.py`

trading_agent 可作为被 WorkBuddy / 复盘应用调度的 Agent（对应架构图「本项目 ↔ WorkBuddy」控制流）：

- `GET /health` 健康检查；`GET /status` 最近一次运行摘要。
- `POST /run` 运行闭环，body 可覆盖 `top_n` / `beg` / `end` / `fast_ma` / `slow_ma` / `no_optim` / `no_writeback`。
- `POST /feedback` 接收用户反馈。

启动：`python main.py --serve [--port 8080]`（或设环境变量 `AGENT_BIND_HOST` / `AGENT_BIND_PORT`）。

### 4.5 触达层 — `notify.py` + `reports/report.py`
- `reports/report.py`：写本地报告（Markdown / CSV / JSON），同时 `write_scan_json` 产出与云端同一份 payload；`prune_reports` 轮转（默认保留最近 20 次，可用 `REPORT_KEEP` 调整）。
- `notify.py`：`get_notifier(cfg)` 返回 `local`（默认，仅本地文件）或 `email`（架构预留，需连接 agent-mail）。
- 微信 / App 提醒：`connectors/push.py` 的企业微信 Webhook 为可选代码路径（配置 `WECOM_WEBHOOK_URL` 后生效）；云端部署实际用 WorkBuddy 智能体邮箱（agent-mail）中转（见 `docs/OPS.md`）。

---

## 5. 数据底座

### 5.1 `data/provider.py`
腾讯 / 东财直连，免费公开接口，含本地缓存（见第 7 节）。

### 5.2 `data/universe.py`
候选池构造：

- 默认池 `config.DEFAULT_UNIVERSE`（跨行业代表性标的，30 只，可作示例）。
- `--use-hot`：同花顺当日强势股作候选池。
- `--universe-size N`：从默认池截取前 N 只。

---

## 6. 跨机器联动（本地 PC → 云端 AIStock）

部署形态：**trading_agent 在本地 PC 运行，AIStock 部署在远程云服务器**。

数据流：

1. 本地 `main.py` 跑完闭环，由 `reports/report.py` 产出 `scan_payload`（共享 JSON，本地查看）。
2. `cloud.push_scan_json` 用 HTTP POST 把 `scan_payload` 推到云端 `POST /api/strategy-scan`，header 带 `x-push-token`（值等于云端环境变量 `STRATEGY_PUSH_TOKEN` / 回退 `CRON_SECRET`）。
3. 云端校验 token 后写入 **D1 表 `strategy_scan`**（Cloudflare Workers 沙箱禁止 handler 写裸文件 `/data/...`，故改用 D1；docker-compose 把 `./data` 挂为 `--persist-to /data`，D1 持久化绑定此卷，容器重建不丢）。
4. 前端「策略扫描」视图 `GET /api/strategy-scan` 读取并展示。
5. 同理，候选回写信号经 `POST /api/writeback-signals` 写入 D1 表 `strategy_writeback`，前端「回写结果」页 `GET` 读取（详见 `docs/OPS.md`）。

配置方式（本地 PC 环境变量，部署时填写，不写则仅本地产出）：

```bash
CLOUD_SCAN_URL=https://<云端host>/api/strategy-scan
CLOUD_SCAN_TOKEN=<与云端 STRATEGY_PUSH_TOKEN / CRON_SECRET 一致>
python main.py
```

也可 `python main.py --no-push` 跳过云端推送（仅本地产出）。推送失败不影响本地闭环（控制台打印状态，不抛异常）。

---

## 7. 数据缓存

`cache/` 下按代码缓存 K 线 / 估值（1 天有效期）。重复运行不再打网络，加速迭代。

---

## 8. 用户调参接口

### 8.1 配置类（集中在 `config.py`）

| 配置类 | 关键字段 | 说明 |
|--------|----------|------|
| `ScreenerConfig` | `top_n` / `w_momentum` / `w_value` / `w_liquidity` / `max_pe_ttm` / `max_pb` | 选股因子与过滤 |
| `SignalConfig` | `fast_ma` / `slow_ma` / `use_breakout_filter` / `breakout_window` / `stop_loss_pct` / `max_positions` | 信号与止损 |
| `BacktestConfig` | `initial_cash` / `fee_rate` / `slippage` | 回测成本 |
| `OptimConfig` | `enabled` / `fast_ma_grid` / `slow_ma_grid` / `metric` / `rounds` | 网格优化 |
| `PushConfig` | `url` / `token` | 云端推送目标与鉴权 |
| `ConnectorsConfig` | `westock_url` / `westock_token` / `tdx_url` / `tdx_api_key` / `wecom_webhook` / `enable_writeback` / `enable_notify` | 连接器（westock-mcp / tdx-connector / 企业微信推送） |
| `AppConfig` | `universe` / `use_hot_universe` / `beg` / `end` / `notifier` / `connectors` | 顶层配置 |

### 8.2 命令行覆盖（`main.py`）

```bash
python main.py                      # 默认：选 8 只 + 优化
python main.py --top-n 10           # 选出 10 只
python main.py --no-optim           # 跳过参数优化
python main.py --use-hot            # 同花顺当日强势股作候选池
python main.py --universe-size 20   # 仅用默认池前 20 只
python main.py --fast-ma 5 --slow-ma 20
python main.py --beg 20250101 --end 20250630
python main.py --notifier email     # local | email
python main.py --no-push            # 跳过云端推送
python main.py --no-connectors      # 强制直连（不使用任何连接器）
python main.py --no-writeback       # 跳过把信号写回通达信
python main.py --serve --port 8080  # 以 HTTP 调度服务方式运行
```

环境变量（连接器接入时填写，留空即不启用）：

```bash
# 腾讯自选股 westock-mcp（行情/估值/K线查询）
WESTOCK_MCP_URL=https://<host>/mcp
WESTOCK_MCP_TOKEN=<token>
# 通达信 tdx-connector（行情 + 条件选股 + 交易接口/执行回写）
TDX_MCP_URL=https://mcp.tdx.com.cn:3001/mcp
TDX_API_KEY=TDX:xxxxxx
# 企业微信机器人（微信/App 提醒推送）
WECOM_WEBHOOK_URL=https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxxx
# 真实回写开关（默认 dry-run 安全，谨慎开启）
TDX_ENABLE_WRITEBACK=1
# Agent 调度服务端口
AGENT_BIND_PORT=8080
```

另保留原有云端推送环境变量：`CLOUD_SCAN_URL` / `CLOUD_SCAN_TOKEN`（云端推送）、`STRATEGY_SCAN_DIR`（本地扫描 JSON 目录）、`REPORT_KEEP`（报告保留份数）。

---

## 9. 已知边界

- 结果为历史数据分析 / 回测 / 模拟，不构成投资建议。**执行回写默认 dry-run 安全**，真实下单需显式开启 `enable_writeback` 且 `dry_run=False`。
- `WestockConnector` / `TdxConnector` 已实现，连接后由 `config.ConnectorsConfig` 启用；未配置则自动退回腾讯/东财直连，保持零连接可跑。
- 微信 / App 提醒：云端部署实际采用 **WorkBuddy 智能体邮箱（agent-mail）** 中转个人微信（零额外账号，具体地址见 `.env` / WorkBuddy 面板）；`connectors/push.py` 的企业微信 Webhook（`WECOM_WEBHOOK_URL`）为可选代码路径，未配置企业微信时不用。个人微信也可选 Server酱 / PushPlus 等第三方 relay。
- **Cloudflare Workers 沙箱禁止 handler 内 `fs.writeFile('/data/...')`**（`operation not permitted`）。扫描/回写结果一律存 D1（`strategy_scan` / `strategy_writeback`），切勿改回裸文件写入。
