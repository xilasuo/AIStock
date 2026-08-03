# 交易 Agent

实现 `docs/trading-agent-architecture.md` 的完整闭环：**选票 → 操作 → 回测 → 优化策略**，
并补齐架构图的「桥接连接器 / 执行回写 / 推送提醒 / 用户反馈闭环 / Agent 调度」。

**默认且推荐：WorkBuddy 当中枢。** `trading_agent` 只做纯计算引擎，数据经可注入的
`DataProvider` 接口传入（中枢从连接器取数后注入），自身不直连任何 MCP；回写与推送也由中枢调用
`tdx-connector` / 企业微信完成。`connectors/` + `bridge.py` 保留为「独立直连模式」备选。

数据底座默认走**真实 A 股公开接口**（腾讯财经估值 + 东财前复权日线），免 key、无需连接连接器即可运行。

## 架构与文档映射

| 文档分层 | 本实现 |
|----------|--------|
| 业务层：选票 | `strategy/screener.py`（多因子打分） |
| 业务层：操作 | `strategy/signals.py`（均线交叉 + 突破 + 止损） |
| 业务层：回测 | `backtest/engine.py` + `backtest/metrics.py` |
| 业务层：优化策略 | `optimization/optimizer.py`（网格搜索 + 消费用户反馈） |
| **中枢：WorkBuddy 编排** | `hub.py`（取数→注入引擎→回写→推送，回调可注入） |
| 中枢：策略计算 Agent | `core/loop.py`（四步编排，接受注入 DataProvider） |
| 中枢：Agent 调度 | `agent_server.py`（HTTP `/run` 接受 prefetched 注入） |
| 数据底座（接口） | `data/provider.py`：`DataProvider` / `StaticProvider`（中枢注入）/ `TencentEastMoneyProvider`（直连兜底） |
| 独立直连模式（备选） | `bridge.py` + `connectors/`（westock / tdx / push 直接调 MCP） |
| 用户反馈闭环 | `feedback_store.py` + `app/api/feedback`（前端有效/无效 → 优化权重） |
| 触达层 | 本地报告 + 云端推送 + 企业微信提醒 |

## 运行

```bash
cd trading_agent
python main.py                  # 默认：选 8 只 + 参数优化
python main.py --top-n 10       # 选出 10 只
python main.py --no-optim       # 跳过优化
python main.py --use-hot        # 同花顺当日强势股作候选池
python main.py --universe-size 20
python main.py --no-connectors  # 强制直连（不碰任何连接器）
python main.py --no-writeback   # 跳过把信号写回通达信
python main.py --serve --port 8080   # 以 HTTP 调度服务运行
```

## WorkBuddy 中枢模式（推荐）

`trading_agent` 作为纯引擎，由 WorkBuddy 中枢驱动完整链路：

1. 在 WorkBuddy 连接器面板 **trust** `westock-mcp` 与 `tdx-connector`（首次会要求填 `tdx-api-key: TDX:xxxx`）；
2. 在本会话让 WorkBuddy 跑中枢编排：调用连接器取数 → 注入引擎（经 `hub.py` 或 `agent_server` 的 `/run` 带 `prefetched`）→ 调用 `tdx-connector` 回写 → 推送企业微信 + 云端 `/api/strategy-scan`；
3. 引擎 HTTP 调度入口：`python main.py --serve`（默认 `127.0.0.1:8080`），中枢可 `POST /run`（支持 `prefetched` 注入、`no_writeback` 交由中枢代管）。

> 执行回写默认 `dry_run=True`（仅模拟，不下真实委托）。要真下单需显式开启 `ENABLE_WRITEBACK=true`。
> 无中枢时，引擎回退腾讯/东财直连，照常运行。

## 连接器接入（独立直连模式，可选）

若不以 WorkBuddy 为中枢、而让 `trading_agent` 自行调 MCP，配置即启用：

```bash
# 腾讯自选股 westock-mcp（行情/估值/K线查询）
export WESTOCK_MCP_URL=https://<host>/mcp
export WESTOCK_MCP_TOKEN=<token>
# 通达信 tdx-connector（行情 + 条件选股 + 交易/执行回写）
export TDX_MCP_URL=https://mcp.tdx.com.cn:3001/mcp
export TDX_API_KEY=TDX:xxxxxx
# 企业微信机器人（微信/App 提醒）
export WECOM_WEBHOOK_URL=https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxxx
# 真实回写开关（默认 dry-run 安全）
export TDX_ENABLE_WRITEBACK=1
python main.py
```

未配置上述变量时，自动退回腾讯/东财直连，保持零连接可跑。

## 可调参数

集中在 `config.py`：`ScreenerConfig`（因子权重/过滤）、`SignalConfig`（均线/突破/止损）、
`BacktestConfig`（手续费/滑点）、`OptimConfig`（网格与目标指标）、`ConnectorsConfig`（连接器）。
亦可经 `main.py` 命令行覆盖。

## 数据缓存

`cache/` 下按代码缓存 K 线 / 估值（1 天有效期），重复运行不再打网络。

## 测试

引擎核心逻辑的单元测试（标准库 `unittest`，零额外依赖）：

```bash
cd trading_agent
python -m unittest tests.test_engine_core -v
```

覆盖的关键金融逻辑（对应评审修复点）：
- **信号无前视**：买入信号日 = 金叉确认次日，慢线窗口未满不产生信号
- **回测止损**：止损按盘中最低价触发、止损日不再开仓
- **真实历史模拟（walk-forward）**：净值曲线正常产出、非恒等
- **单票风险预算**：单票权重 ≤ `risk_per_position / |stop_loss|`（风控联动）

## 已知边界

- 本系统为**分析 / 回测 / 模拟**框架，结果基于历史数据，不构成投资建议。
- 执行回写默认 `dry_run=True` 安全，真实下单需显式开启 `enable_writeback` 且 `dry_run=False`。
- 微信 / App 提醒经企业微信 Webhook 实现；推送到腾讯自选股 App 本身需另行接入官方通道。
