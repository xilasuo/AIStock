# AIStock · PC 端使用手册

本手册是给**在自己电脑上操作这套系统的人**看的：怎么装、怎么配、每天怎么用、出问题怎么查。
偏设计的说明见 `docs/trading-agent-architecture.md`，偏部署/排错的见 `docs/OPS.md`，开发者视角见 `trading_agent/README.md`。

---

## 0. 这套系统在 PC 上到底做什么

你电脑上的 `trading_agent/` 是一个**量化计算引擎**。它每天做一件事：

> 从行情里筛出一批值得关注的 A 股 → 算买卖信号和回测 → 把结果发到你的**邮箱**和**云端复盘 App**。

你几乎不用手动操作——日常是「自动跑 + 早上看一眼邮箱」。

整个链路分三块：

| 角色 | 在哪 | 干什么 |
|------|------|--------|
| **本地 PC · 计算引擎** `trading_agent` | 你的电脑 | 选股 / 信号 / 回测 / 优化（纯计算） |
| **WorkBuddy · 中枢** | WorkBuddy 应用 | 取行情数据、编排流程、定时触发、发邮件 |
| **云端 AIStock** | 服务器 `http://<SERVER_HOST>:9003` | 展示「策略扫描」「回写结果」页面 |

数据流：`WorkBuddy 取数 → 注入 trading_agent 引擎 → 引擎算出结果 → 推云端 + 发邮箱`。

---

## 1. 首次准备（只做一次）

### 1.1 代码与 Python

- 代码仓库已在本地：`D:/code/AICode/AIStock`（或自行 `git clone`）。
- **Python 3.13**。`trading_agent` 只依赖 Python 标准库，**不需要 `pip install` 任何东西**。
  - 若命令行里 `python`/`python3` 指向 3.13 可直接用；
  - 本机有 WorkBuddy 管理的 Python，也可用完整路径：`<PYTHON_3_13_PATH>`。

### 1.2 配置 `.env`（PC 侧关心的几项）

配置在仓库根目录的 `.env`（由 `cp .env.example .env` 生成）。**PC 端只用到下面这几项**：

```dotenv
# 云端复盘 App 接收地址（把选股结果推到服务器）
CLOUD_SCAN_URL=http://<SERVER_HOST>:9003/api/strategy-scan
CLOUD_SCAN_TOKEN=<与云端 STRATEGY_PUSH_TOKEN 相同的字符串>
CLOUD_WRITEBACK_URL=http://<SERVER_HOST>:9003/api/writeback-signals

# 个人微信推送（可选，二选一；不填则只走邮箱）
# WX_PUSH_DRIVER=servercan
# SERVERCHAN_KEY=你的SendKey
# PUSHPLUS_TOKEN=你的Token
```

> ⚠️ **两端 token 必须一致**：本地 `CLOUD_SCAN_TOKEN` 要等于云端 `.env` 的 `STRATEGY_PUSH_TOKEN`，否则推送返回 `401`。
> ⚠️ **`trading_agent` 不自动读取 `.env`**。配置只从环境变量取：日常靠 WorkBuddy 自动化注入；手动在终端跑时要自己 `export`（见第 5 节）。

### 1.3 连接器（WorkBuddy 面板，一次性）

在 WorkBuddy 连接器面板 **trust** 这两个（已验证可用）：

- `westock-mcp`（腾讯自选股，行情/估值/K线查询）
- `tdx-connector`（通达信，行情/条件选股；首次需填 `tdx-api-key: TDX:xxxx`）

> 即使不配连接器，引擎也能退回**腾讯/东财公开接口直连**，零配置可跑。

### 1.4 智能体邮箱（已开通）

WorkBuddy 智能体邮箱已开通（具体地址见 `.env` / WorkBuddy 面板）。每日选股摘要会发到这里，手机邮件 App 即可收。

---

## 2. 日常使用（两种入口）

### 2.1 全自动（推荐）：每个交易日盘前 09:00

什么都不用做。WorkBuddy 自动化 `每日选股中枢编排（盘前）` 会在工作日 **09:00** 自动执行：

1. 读取候选池 `trading_agent/watchlist.json`（12 只跨行业蓝筹）；
2. 用 `tdx-connector` / `westock-mcp` 取最新 K 线与估值；
3. 写成 `trading_agent/prefetched.json`；
4. 运行 `run_hub.py` 跑引擎（选股 → 信号 → 回测 → 优化）；
5. 推送云端「策略扫描」「回写结果」两页，并往智能体邮箱发邮件摘要。

**你早上打开邮箱看一眼即可。**

### 2.2 手动触发（想随时跑一次）

在 WorkBuddy 对话里直接说，例如：

> 「跑一下今日的选股中枢编排」
> 「现在执行一次盘前选股」

WorkBuddy 会按上面的流程跑一遍并回报结果。

### 2.3 查看结果

| 渠道 | 位置 | 内容 |
|------|------|------|
| **邮箱** | 智能体邮箱 | 选股摘要（标题「盘前选股 YYYY-MM-DD」，含入选标的/PE/PB/动量 + 回测） |
| **云端 App** | `http://<SERVER_HOST>:9003/` → 登录 → 「策略扫描」「回写结果」 | 完整扫描结果 + 候选回写信号（标注「模拟 dry-run」） |
| **本地文件** | `trading_agent/scan_payload.json`、`signals_out.json`、`reports/` | 引擎原始产出，方便本地查看/调试 |

---

## 3. 选股数据如何推送到服务器

你选出来的股票数据，是**每天运行时通过 HTTP 推到云端服务器**的——这和「git 推送代码」（见 `docs/OPS.md`）是两回事。下面把整条链路一次讲清。

### 3.1 端到端链路

```
WorkBuddy 每日 09:00 自动化（或你手动说一句触发）
   ├─ 取行情（tdx-connector / westock-mcp）→ 写 prefetched.json
   ├─ 运行 run_hub.py 跑纯引擎
   │     选股 → 信号 → 回测 → 优化
   │     本地产出 scan_payload.json + signals_out.json
   └─ run_hub.py 自动发两条 HTTP POST（header 带 x-push-token）
          │
          ├─ POST /api/strategy-scan      → 存 D1 表 strategy_scan      → 「策略扫描」页
          └─ POST /api/writeback-signals  → 存 D1 表 strategy_writeback → 「回写结果」页
```

> 云端收到后存进 **D1 数据库**，不是文件。早期版本写 `/data` 裸文件会被 Cloudflare Workers 沙箱拒绝（报 `500 operation not permitted`），现已全部改为 D1 存储。前端页面从 D1 读取并渲染。

### 3.2 两个推送接口

| 本地产物 | 函数 | 推送地址（环境变量） | 云端存到 | 前端页 |
|----------|------|----------------------|----------|--------|
| 选股+回测 `scan_payload.json` | `push_scan()` | `CLOUD_SCAN_URL` → `/api/strategy-scan` | D1 表 `strategy_scan` | 「策略扫描」 |
| 候选回写 `signals_out.json` | `push_writeback()` | `CLOUD_WRITEBACK_URL` → `/api/writeback-signals` | D1 表 `strategy_writeback` | 「回写结果」 |

- 两条 POST 都要求 header `x-push-token`，值须等于云端 `STRATEGY_PUSH_TOKEN`。
- 本地 `CLOUD_SCAN_TOKEN` 同时充当两个接口的 token（回写接口默认也读 `CLOUD_SCAN_TOKEN`，见 `run_hub.py` 第 269 行）。
- token 对不上 → `401`；服务器还没重建 D1 路由 → `500`（详见第 7 节 / `docs/OPS.md`）。

### 3.3 用到的环境变量

| 变量 | 作用 | 在哪配 |
|------|------|--------|
| `CLOUD_SCAN_URL` | 「策略扫描」推送地址 | PC 端 `.env` |
| `CLOUD_WRITEBACK_URL` | 「回写结果」推送地址 | PC 端 `.env` |
| `CLOUD_SCAN_TOKEN` | 推送鉴权 token（两端须一致） | PC 端 `.env` |
| `STRATEGY_PUSH_TOKEN` | 云端校验 token（须 == 本地 `CLOUD_SCAN_TOKEN`） | 云端 `.env` |

> ⚠️ `run_hub.py` **不自动读 `.env`**，变量由 WorkBuddy 自动化注入进程环境；手动在终端跑要先 `export`（见第 5 节）。

### 3.4 怎么确认推上去了

跑完 `run_hub.py`（第 5 节命令）后，终端会打印：

```
扫描推送 成功 (HTTP 200) -> http://<SERVER_HOST>:9003/api/strategy-scan
回写推送 成功 (HTTP 200) -> http://<SERVER_HOST>:9003/api/writeback-signals
```

看到两个 `HTTP 200` 即推送成功；随后打开 `http://<SERVER_HOST>:9003/` 登录，看「策略扫描」「回写结果」两个视图即为当天真实数据。

---

## 4. 关键文件说明

| 文件 | 作用 | 谁产生 |
|------|------|--------|
| `trading_agent/watchlist.json` | 候选股票池（12 只蓝筹） | 你/初始配置 |
| `trading_agent/prefetched.json` | 中枢取数后注入引擎的数据（K线+估值） | WorkBuddy 自动化（本地有样例，已 gitignore） |
| `trading_agent/scan_payload.json` | 引擎产出的完整扫描结果 | `run_hub.py` |
| `trading_agent/signals_out.json` | 候选买入信号（含最新价，供回写） | `run_hub.py` |
| `trading_agent/reports/` | 本地 Markdown/CSV/JSON 报告（保留最近 20 次） | `main.py` |
| `trading_agent/cache/` | K线/估值缓存（1 天有效，加速重复运行） | 引擎 |

---

## 5. 手动从终端运行（调试 / 验证用）

> 适用场景：想自己验证、或 WorkBuddy 不在时本地跑一遍。**注意**：此方式需手动设置环境变量（见 1.2），因为 `trading_agent` 不自动读 `.env`。

### 4.1 中枢模式（与每日自动化同款）

先确保已有 `prefetched.json`（让 WorkBuddy 跑一次自动化即生成；或用仓库内本地样例）：

```bash
cd D:/code/AICode/AIStock/trading_agent

# 设置环境变量（token 须与云端一致）
export CLOUD_SCAN_URL=http://<SERVER_HOST>:9003/api/strategy-scan
export CLOUD_SCAN_TOKEN=<你的token>
export CLOUD_WRITEBACK_URL=http://<SERVER_HOST>:9003/api/writeback-signals

# 跑引擎并推送
python run_hub.py --prefetched prefetched.json
```

参数说明：

- `--prefetched`：必填，中枢注入的数据文件。
- `--scan-url` / `--scan-token`：覆盖「策略扫描」推送地址/令牌（默认读环境变量，一般不用加）。
- `--push-url` / `--push-token`：覆盖「回写结果」推送（默认读 `CLOUD_WRITEBACK_URL` / `CLOUD_SCAN_TOKEN`）。
- `--out-dir`：输出文件目录（默认 `trading_agent/`）。

运行后会打印入选标的、回测指标、候选回写信号，并在配置了地址时打印 `扫描推送 成功 (HTTP 200)` / `回写推送 成功 (HTTP 200)`。

### 4.2 独立直连模式（不用 WorkBuddy，零配置）

不需要任何连接器，引擎直接走腾讯/东财公开接口：

```bash
cd D:/code/AICode/AIStock/trading_agent

python main.py                      # 默认：选 8 只 + 参数优化
python main.py --top-n 10           # 选出 10 只
python main.py --no-optim           # 跳过参数优化
python main.py --use-hot            # 用同花顺当日强势股作候选池
python main.py --universe-size 20   # 仅用默认池前 20 只
python main.py --fast-ma 5 --slow-ma 20
python main.py --no-connectors      # 强制直连（不碰任何连接器）
python main.py --no-push            # 只本地产出，不推云端
python main.py --serve --port 8080  # 以 HTTP 服务方式运行（供 WorkBuddy 调度）
```

> 区别：`main.py` 会写本地报告、可按 env 推云端，但**不发 agent-mail 邮件**（邮件由每日自动化负责）。日常使用走 2.1 全自动即可。

---

## 6. 常用参数调整

| 想改什么 | 怎么改 |
|----------|--------|
| 候选池 | 编辑 `watchlist.json`；或 `main.py --universe-size N` / `--use-hot` |
| 选出数量 | `prefetched.json` 的 `config.top_n`，或 `main.py --top-n` |
| 均线周期 | `config.fast_ma` / `config.slow_ma`（prefetched 的 `config` 或 `main.py --fast-ma/--slow-ma`） |
| 因子权重/过滤 | `trading_agent/config.py` 的 `ScreenerConfig`（动量/估值/流动性权重、PE/PB 上限、换手下限） |
| 止损 | `config.py` 的 `SignalConfig.stop_loss_pct` |
| 是否优化 | `config.optim.enabled` 或 `main.py --no-optim` |

> 调参后建议先手动跑一次 `run_hub.py` 看结果，满意了再交给每日自动化。

---

## 7. 故障排查（PC 侧）

| 现象 | 可能原因 | 处理 |
|------|----------|------|
| 早上没收到邮件 | WorkBuddy 没在线 / 自动化未运行 / agent-mail 未连接 | 打开 WorkBuddy 确认自动化状态；确认 agent-mail 已开通绑定 |
| 推送 `401 unauthorized` | `CLOUD_SCAN_TOKEN` 与云端 `STRATEGY_PUSH_TOKEN` 不一致；或手动跑没 export token | 两端改成同一字符串；手动跑前先 `export` |
| 推送 `500` + `operation not permitted` | 云端容器还在跑旧路由（写 `/data` 文件） | 服务器侧问题，见 `docs/OPS.md` 第 2/3 节：git pull + 重建容器 |
| 手动跑报「prefetched.json 中没有可用标的」 | 还没生成 prefetched.json | 先让 WorkBuddy 跑一次自动化，或用仓库内样例 |
| 手动跑报 `ModuleNotFoundError` | 不在 `trading_agent/` 目录运行 | `cd trading_agent` 后再跑 |
| 手动跑配置「没生效」 | `trading_agent` 不自动读 `.env` | 用 `export` 设置环境变量，或交给 WorkBuddy 自动化 |
| 想看引擎原始结果 | — | 看 `scan_payload.json` / `signals_out.json` / `reports/` |

---

## 8. 安全与诚实声明

- **密钥只放 `.env`**：token / webhook / 邮箱地址不写进代码或文档。本地与云端 `STRATEGY_PUSH_TOKEN` / `CLOUD_SCAN_TOKEN` 必须一致。
- **回写为模拟（dry-run）**：当前 `tdx-connector` 只暴露查询工具、**没有下单接口**，所以「回写结果」页里的信号恒为候选/模拟，不会真下单。真实下单需接入带 `place_order` 的券商 MCP。
- 选股结果是基于历史数据的回测/模拟，**不构成投资建议**。

---

## 9. 一句话速记

> **平时不用管**——每个交易日 09:00 WorkBuddy 自动跑，结果进邮箱 + 云端 App。
> **想手动**：在 WorkBuddy 说「跑一次选股」；或终端 `cd trading_agent && python run_hub.py --prefetched prefetched.json`（记得 export 环境变量）。
> **改候选池**：编辑 `watchlist.json`。**改算法**：`config.py`。
