# AIStock 运维手册（OPS）

本文件沉淀**部署 / 重建 / 推送联动**的实操知识，是 `README.md`（部署流程）与 `trading-agent-architecture.md`（设计）的补充。设计原理看架构文档，怎么安全重建和排错看这里。

> 密钥（token / webhook / 邮箱地址的明文）**只存在于 `.env`，绝不写进本仓库任何文档或代码注释**。下文一律以环境变量名指代。

---

## 1. 推送联动接口（本地 PC → 云端）

trading_agent 在本地 PC 跑完闭环，把结果 HTTP POST 到云端 AIStock（Docker，端口 9003）：

| 用途 | 端点 | 存储 | 前端读取 |
|------|------|------|----------|
| 策略扫描 | `POST /api/strategy-scan` | D1 表 `strategy_scan` | `GET /api/strategy-scan` → 「策略扫描」页 |
| 回写结果 | `POST /api/writeback-signals` | D1 表 `strategy_writeback` | `GET /api/writeback-signals` → 「回写结果」页 |

鉴权：两个 POST 都要求 header `x-push-token`，值须等于云端 `STRATEGY_PUSH_TOKEN`（未设则回退 `CRON_SECRET`）。
不匹配返回 `401`；payload 缺 `selected` 字段返回 `400`；正常返回 `200`。

本地 PC 侧环境变量（填了才推送，不填仅本地产出）：

```bash
CLOUD_SCAN_URL=http://<云端host>:9003/api/strategy-scan
CLOUD_SCAN_TOKEN=<与云端 STRATEGY_PUSH_TOKEN 一致>
CLOUD_WRITEBACK_URL=http://<云端host>:9003/api/writeback-signals
# run_hub.py 会优先读以上变量；也可用参数覆盖：
#   python run_hub.py --prefetched prefetched.json \
#     --scan-url $CLOUD_SCAN_URL --push-url $CLOUD_WRITEBACK_URL
```

> ⚠️ 调用 `run_hub.py` 时**务必让 token 从 `.env` 读取，不要硬编码 `--scan-token` 覆盖**，否则会与云端 `STRATEGY_PUSH_TOKEN` 不一致，导致 `401`。

### 1.1 云端配置拉取（多用户鉴权）

除「推送结果」外，`run_hub.py` 在跑引擎前还会从云端拉取策略配置（`GET /api/strategy-scan/config`），使自动化用云端调好的参数（`top_n`、因子权重、优化开关等）而非本地默认。

**多用户隔离后的鉴权模型（重要，两条链路相互独立；2026-08-04 改造）：**
- `GET /api/strategy-scan/config` 按**登录会话身份**返回「本人」配置。云端 `strategy_config` 表已加 `user_id`，每个登录账号保存自己的隔离行、**互不覆盖**；本人从未保存过时回退 `user_id IS NULL` 的全局默认。匿名或仅持共享推送 token（无登录身份）也回退全局默认。
- **选股结果（选出的股票）同样按用户隔离**：`strategy_scan` 表已加可空 `user_id`。前端「策略扫描」页 `GET /api/strategy-scan` 仅展示**当前登录用户本人**的最新结果（本人无则回退 `user_id IS NULL` 的全局遗留结果）。推送 `POST /api/strategy-scan` 以**登录会话**调用时写入本人隔离行（`user_id=本人 id`）；仅持共享 `x-push-token`（无登录身份，兼容老自动化）时落入全局桶（`user_id NULL`），且**禁止伪造他人 user_id**。本地 `run_hub.py` 推送已复用配置拉取时的登录 cookie，自动按 `.env` 的 `CLOUD_CFG_USER` 身份写入隔离结果。
- **本地服务用哪个账号，就用那份账号的策略**：`run_hub.py` / `pull_cloud_config.py` 通过 `.env` 的 `CLOUD_CFG_USER` / `CLOUD_CFG_PASS` 登录云端，拉取**该账号本人**配置。所以「本地自动化跑的是谁的策略」完全由 `.env` 这两个变量决定——配 `admin` 就用 admin 的，配 `yedaibo` 就用 `yedaibo` 的。不存在「服务器猜用户」这回事，身份由 `.env` 显式给定。
- 推送 `POST /api/strategy-scan`、`POST /api/writeback-signals` 仍以共享 `x-push-token` 作基础鉴权（本节开头），但**本地 `run_hub.py` 已复用配置拉取的登录会话 Cookie 一并下发**。云端据此把结果写入**本人隔离桶**（`user_id=本人`）；仅持 token、无登录身份（兼容老自动化/异构推送源）才落入 `user_id NULL` 的全局桶，且**无法伪造他人 user_id**。故前端「策略扫描」「回写结果」两页均按登录用户只展示本人数据，全局桶仅作无本人数据时的回退。
- `GET /api/strategy-scan`、`GET /api/writeback-signals` 均按登录身份 `WHERE user_id=? OR user_id IS NULL`（本人行优先）返回，绝不暴露他人数据。

**铁律**：
1. `.env` 的 `CLOUD_CFG_USER` / `CLOUD_CFG_PASS` 必须是云端**真实存在的账号**且密码正确。登录被拒 → 配置读取失败 → `run_hub` 退回本地 `strategy_config.yaml`（报告 / `cloud_strategy_receipt.json` 出现 `source=local-fallback`，自动化看似在跑但用的是本地默认参数，并非云端调好的策略）。
2. 想让本地自动化用「本人独立策略」，需两步：① 先在网页用**本人账号**登录并保存一次配置（生成隔离行）；② 再把 `.env` 的 `CLOUD_CFG_USER/CLOUD_CFG_PASS` 配成本人账号。只改云端 admin 密码时，记得同步 `.env` 的 `CLOUD_CFG_PASS`。
3. 若本人从未在网页保存过配置，GET 回退全局默认——这是预期行为，不是故障；一旦网页保存即锁定为本人配置。

---

## 2. 重建 / 更新部署（最重要）

### 2.1 标准流程（README 已有）

```bash
git pull origin main
./deploy.sh          # 内部 docker compose build（不带 --no-cache）+ up
```

### 2.2 两个真实踩坑（务必遵守）

**坑一：本地没 push，服务器 pull 不到新代码。**
服务器是从它**自己的 git checkout** 构建的。本地改了 `route.ts` 但没 `git push`，服务器 `git pull` 拿不到任何东西，容器跑的仍是旧代码。
→ 改完代码后**先 `git push origin main`**，再上服务器 `git pull`。

**坑二：Docker 层缓存把旧构建产物喂给你。**
`deploy.sh` 为加速**不带 `--no-cache`**。仅改源码时这没问题（命中 `node_modules` 缓存，只重跑 build）；但若曾遇诡异「代码改了但线上行为没变」，是缓存层复用了旧产物。
→ 强制干净重建：

```bash
docker compose build --no-cache fupanbu
docker compose up -d --force-recreate fupanbu
```

**验证新代码确实上线**（以 D1 迁移为例，确认 route 已含 D1 逻辑）：

```bash
# 进容器看源码是否含 strategyScan（D1 版标志）
docker compose exec fupanbu grep -l "strategyScan" /app/app/api/strategy-scan/route.ts
```

### 2.3 一键重建检查清单

1. 本地：`git add -A && git commit -m "..." && git push origin main`
2. 服务器：`git pull origin main`
3. 服务器：`docker compose build --no-cache fupanbu && docker compose up -d --force-recreate fupanbu`
4. 验证：浏览器开 `http://<host>:9003/`，看「策略扫描」「回写结果」是否能正常进（无 500）
5. 本地：跑 `run_hub.py` 推送，确认两端 `HTTP 200`；或一键回归：`source .env && python trading_agent/probe_cloud_test.py`（覆盖登录 / 配置拉取 / 推送 / 落库 / 鉴权边界）

---

## 3. Cloudflare Workers 的 fs 限制（500 错误的根因）

**现象**：推送后云端返回 `500`，日志 `write failed: operation not permitted`（EPERM）。

**原因**：Cloudflare Workers 沙箱**禁止在请求处理函数里写裸文件系统**（`fs.writeFile('/data/...')` 一律失败）。`--persist-to /data` 只服务于 D1 / KV，不提供任意文件写。

**修复（已落地）**：扫描/回写结果改存 **D1 表** `strategy_scan` / `strategy_writeback`，由 `db/schema.ts` + `db/index.ts` 的 `ensureSchema()` 建表。`docker-compose` 把 `./data` 挂为 `--persist-to /data`，D1 持久化绑定此卷，**容器重建不丢**。

**铁律**：不要为了「落盘可看」把这两处改回文件写入；需要本地查看用 `reports/report.py` 的本地报告。

---

## 4. 个人微信触达通道决策

- **现状**：未配置企业微信。个人微信收提醒走 **WorkBuddy 智能体邮箱（agent-mail）** 中转（零额外账号，已开通）。
- **机制**：WorkBuddy 自动化在盘前（工作日 09:00）编排 → 取数 → 跑引擎 → 用 agent-mail `SendMessage` 把选股摘要发到绑定邮箱，个人微信收邮件提醒。
- **备选**：若想直接推微信消息，可用 Server酱（`SERVERCHAN_KEY`）/ PushPlus（`PUSHPLUS_TOKEN`）等第三方 relay，由 `run_hub.py` 的 `push_wechat()` 发送（本机 Python 出站可达；WorkBuddy 沙箱内出站被限，故在本地 PC 跑）。
- **不要用**企业微信 Webhook（`WECOM_WEBHOOK_URL`）——那是 `connectors/push.py` 的可选代码路径，未配置企业微信时无效。

---

## 5. 连接器边界（诚实声明）

- `tdx-connector` / `westock-mcp` 当前仅暴露**查询类工具**（K 线、行情、估值、条件选股），**无 `place_order`**。
- 因此枢纽推送过来的「回写信号」恒为**候选回写 / dry-run**，前端「回写结果」页已标注「模拟」。真实下单需接入带下单能力的连接器并显式关闭 dry-run。
- 选股结果是历史数据 / 回测 / 模拟，**不构成投资建议**。

---

## 6. 环境变量约定（密钥清单）

| 变量 | 作用 | 位置 |
|------|------|------|
| `STRATEGY_PUSH_TOKEN` | 推送鉴权（云端 + 本地 `CLOUD_SCAN_TOKEN` 须一致） | 云端 `.env`；`start.sh` 注入 wrangler `.dev.vars` |
| `CLOUD_SCAN_URL` / `CLOUD_SCAN_TOKEN` | 本地 PC 推送目标与 token | 本地 PC `.env` |
| `CLOUD_WRITEBACK_URL` | 本地 PC 回写推送目标 | 本地 PC `.env` |
| `WX_PUSH_DRIVER` / `SERVERCHAN_KEY` / `PUSHPLUS_TOKEN` | 微信 relay（可选） | 本地 PC `.env` |
| `CRON_SECRET` | `STRATEGY_PUSH_TOKEN` 的兜底 | 云端 `.env` |
| `CLOUD_CFG_PASS` | 登录云端 `admin` 拉取策略配置（**须等于云端 `admin` 真实密码**） | 本地 PC `.env` |
| `CLOUD_BASE_URL` | 云端基地址（run_hub 的 `--cloud-config-url`；缺失则 local-fallback） | 本地 PC `.env` |
| `CLOUD_CFG_USER` | 登录云端拉取**本人**配置的用户名；决定本地自动化用「谁的策略」（按用户隔离，见 §1.1） | 本地 PC `.env` |

> 任何 token 缺失或错配都会让推送返回 `401`。改 token 后记得本地与云端**两边同步**，并走第 2.3 节重建检查清单。

---

## 7. 快速排错

| 症状 | 可能原因 | 处理 |
|------|----------|------|
| 推送 `401` | token 不一致 / 硬编码覆盖 / 改了没同步 | 核对本地 `CLOUD_SCAN_TOKEN` == 云端 `STRATEGY_PUSH_TOKEN`；去掉 `--scan-token` 硬编码 |
| 推送 `500` + `operation not permitted` | route 仍写 `/data` 文件 | 确认已用 D1 版 route（第 3 节），并走重建检查清单 |
| 页面 404「尚未生成结果」 | 本地还没推送 / 推送失败 | 跑 `run_hub.py` 推送，看是否 `200` |
| 线上行为像旧代码 | 没 push / Docker 缓存 | 第 2.2 节两步排查 |
| 微信收不到 | 未跑本地 agent-mail 自动化 | 检查 WorkBuddy 自动化是否运行、agent-mail 是否连接 |
| 报告 / `cloud_strategy_receipt.json` 出现 `source=local-fallback` | 云端配置拉取失败（`CLOUD_CFG_PASS` ≠ 云端 `admin` 真实密码，或云端改了密码没同步） | 对齐本地 `.env` 的 `CLOUD_CFG_PASS` 与云端 `admin` 真实密码；本地 `source .env` 后重跑 `run_hub` |
| 配置接口 `GET /api/strategy-scan/config` 返回 `401` | 同上，登录会话缺失 | 同上；或等云端重建部署后走 token 兜底（`requireApiUserOrPushToken`） |
| 本地自动化用的是「别人的 / 全局的」配置而非本人 | `.env` 的 `CLOUD_CFG_USER` 不是本人账号，或本人从未在网页保存过配置（回退全局默认） | 确保 `.env` 配本人账号且本人已在网页保存过配置；用 `probe_cloud_test.py` 核对返回的 `scope`（应为 `user`）与 `source` |
| 想快速验证本地 ↔ 云端整条链路 | — | 本地 `source .env` 后跑 `python trading_agent/probe_cloud_test.py`（8 子项自检：登录 / 配置拉取 / 推送 / 落库 / 鉴权边界） |

---

## 8. WorkBuddy 自动化编排（盘前·邮箱+企业微信推送）

> 本自动化（名称「每日选股中枢编排（盘前·邮箱+企业微信推送）」，状态 ACTIVE）是「中枢模式」的定时驱动方，存储于 WorkBuddy 自动化数据库（**不在本仓库**）。此处沉淀其编排逻辑，便于维护与复现。**下文不记录任何 token / 密码明文；本地绝对路径一律泛化为相对路径或 `<...>` 占位符；邮箱地址仅以「agent-mail 智能体邮箱」指代（明文见使用手册）。**

### 8.1 元信息

| 项 | 值 |
|----|----|
| 触发（RRULE） | `FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0`（工作日 09:00） |
| 工作目录 cwd | `trading_agent/` |
| Python 运行时 | WorkBuddy 托管 Python 3.13（自动化内以 `PY` 指代，各环境路径不同） |
| 推送通道 | 主：agent-mail 智能体邮箱；次：企业微信（wecom 连接器） |
| 策略来源 | 云端 `GET /api/strategy-scan/config`（鉴权见 §1.1） |

### 8.2 编排流程（10 步提炼）

0. **准备凭据**：解析 `.env` 取 `CLOUD_BASE_URL`、`CLOUD_CFG_USER`、`CLOUD_CFG_PASS`、`WX_PUSH_DRIVER`、`SERVERCHAN_KEY`、`PUSHPLUS_TOKEN`、`CLOUD_SCAN_URL`、`CLOUD_SCAN_TOKEN`、`CLOUD_WRITEBACK_URL`，连同 `PY`、`TA=trading_agent/` 注入后续命令环境（端到端前务必注入，见 §1.1 时序坑）。
1. **生成双源查询**：`PY build_market_universe.py` 登录云端读策略配置，打印 `TDEX_QUERY`（自然语言）、`WESTOCK_FILTER_PRESET`、`WESTOCK_FILTER_MAX_PE`。
2. **双源候选池**：
   - 通达信 `tdx_screener`（message=TDEX_QUERY，rang=AG，分页）→ 收集纯数字代码，上限 **120** 或末页止；
   - 腾讯自选股 `tool_filter`（preset / max_pe，limit=120）→ 去 sh/sz/bj 前缀收集代码；
   - 合并去重写 `market_universe.json`（含 `index=000300`）。
3. **股单参考**：westock `data_stocklist(mode=rank, limit=10)` 取腾讯官方股单榜（报告「主题参考」段）。
4. **双连接器取数 → `prefetched.json`**：
   - K线：`tdx_kline`（setcode 规则：6/9→1，0/2/3→0，8/4→2；period=4 日线；wantNum=130；前复权）；
   - 估值/换手/市值：`westock data_quote`（每批 ≤50，按市场前缀拼接）；
   - 指数牛熊：`tdx_kline(code=000300, setcode=62, target=1)`；
   - 汇总写 `prefetched.json`：`{universe, klines{...,000300}, quotes, hot:[]}`。
5. **兜底**：若步骤 2 双源皆空，读 `watchlist.json` 的 `codes` 作 universe，同样取数，报告标注「⚠️ 已回退 watchlist 兜底」。
6. **运行引擎**：`PY run_hub.py --prefetched prefetched.json --cloud-config-url $CLOUD_BASE_URL --cloud-user $CLOUD_CFG_USER --cloud-pass $CLOUD_CFG_PASS`（cwd=TA）。run_hub 会：① 登录云端拉配置套用（yaml<云端<prefetched/CLI；若 `CLOUD_BASE_URL` 为空或登录失败则 `local-fallback`，见 §1.1）② StaticProvider 注入 prefetched ③ 按云端因子权重打分取 top_n ④ 扫描 POST 到 `CLOUD_SCAN_URL`、回写 POST 到 `CLOUD_WRITEBACK_URL` ⑤ 写 `scan_payload.json` / `signals_out.json` / `cloud_strategy_receipt.json`。
7. **合并报告**：读 scan_payload + receipt，再拉完整云端策略做「策略快照」（top_n、因子权重、optim、SHA 指纹前 8 位）；含入选结果、腾讯股单主题、策略溯源凭证（source/fetched_at/login_ok/config_sha256 等）。`source=local-fallback` 必须告警。
8. **推送邮箱（主）**：agent-mail `SendMessage`，subject「盘前选股 YYYY-MM-DD」，body=合并报告；未开通则跳过提示。
9. **推送企业微信（次）**：wecom 连接器发送同一报告；失败仅记录不中断。
10. **收尾简述**：各通道状态、策略来源（cloud/local-fallback）、牛熊判定、本策略 SHA 指纹前 8 位。tdx-connector 无 `place_order` → 回写恒 dry-run（§5）。

### 8.3 关键产物

| 文件 | 作用 | gitignore |
|------|------|-----------|
| `market_universe.json` | 双源去重候选池 | ✓ |
| `prefetched.json` | 注入引擎的 K线 + 估值 + 指数 | ✓ |
| `scan_payload.json` / `signals_out.json` | 选股结果 / 候选回写信号 | ✓ |
| `cloud_strategy_receipt.json` | 云端策略溯源凭证（`source` 字段是健康度关键指标） | — |
| `reports/report_YYYY-MM-DD.md` | 盘前合并报告（双渠道推送正文） | ✓ |
| `reports/report_YYYY-MM-DD_priorrun.md` | 前一次运行报告（对比用） | ✓ |
| `reports/report_YYYYMMDD_HHMM.md` | 标准引擎运行报告（main.py 产出） | ✓ |

### 8.4 维护要点

- 编排逻辑只改 **WorkBuddy 自动化本身**（不在仓库）；本仓库 `trading_agent/` 下的脚本由自动化调用，**自动化不应改动源码**（prompt 已约束）。
- `CLOUD_CFG_PASS` 一致性（§1.1）、`CLOUD_BASE_URL` / `x-push-token` 一致性（§1）是自动化正常工作的前置条件；链路验证用 `probe_cloud_test.py`（§2.3 / §7）。
- 修改后如需确认中枢真实行为，可在 WorkBuddy 手动触发一次「盘前选股」，或直接本地 `source .env && PY run_hub.py --prefetched prefetched.json` 复跑引擎段。
