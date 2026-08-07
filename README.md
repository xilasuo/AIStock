# 我的复盘助手

面向个人使用的 A 股记录与复盘工具。它负责整理公开行情、记录交易、触发价格提醒并辅助复盘，不提供荐股或自动交易。

技术栈：Next.js 16（App Router，前端页面与 API 路由都在 `app/`）+ Cloudflare Workers（边缘入口在 `worker/`，拉起 Next 构建产物）+ Cloudflare D1（SQLite）+ drizzle ORM（仅作查询层，建表由运行时 `ensureSchema` 负责）。构建使用 `vinext`（Cloudflare 适配的 Next 构建工具，非原生 `next`）。架构是「纯前端 + 边缘函数 + SQLite」，无独立后端单体服务。仓库内也包含 `Dockerfile`/`docker-compose.yml`（方便自托管）与 `trading_agent/`（Python 量化脚本，详见下文）。

> **数据库 schema 事实源说明**：`drizzle/` 迁移目录与 `drizzle-kit` 已废弃。所有建表、加列、建索引的唯一事实源是 `db/index.ts` 的 `ensureSchema()`（运行时幂等执行，`CREATE TABLE/INDEX IF NOT EXISTS` + 增量 `addColumnIfMissing`）。`db/schema.ts` 仅作为 drizzle 查询类型推断与人工对照文档，**禁止再运行 `drizzle-kit generate`**。任何结构变更必须先改 `ensureSchema`，再同步镜像到 `schema.ts`。

## 主要功能

- 账号体系（Cookie session，多用户 + 超级管理员）：密码仅存 PBKDF2 哈希 + 随机 salt，绝不存明文。登录页为独立的 `app/login/page.tsx`，主应用 `app/page.tsx` 在服务端校验登录后才渲染 `Dashboard`。首次启动时用 `APP_USERNAME`/`APP_PASSWORD` 自动 seed 一个超级管理员，管理员可在「设置 → 用户」中增删用户、设置角色（`super_admin`/`user`）、禁用账号；普通用户不能自助注册。所有业务数据均按 `user_id` 隔离归属当前登录用户，数据接口均按登录会话鉴权
- 行情、财务与题材信息多源整理：配置麦蕊智数 token 后，实时行情、PE/PB、营收/利润/负债率、ROE、行业/简介等**优先取麦蕊**（原生 A 股源、国内稳定）；未配置则自动回退腾讯 / 东方财富 / 新浪免费多源，缺失字段以技术面为主分析
- DeepSeek 或任意 OpenAI 兼容模型解释（也支持 Ollama / OpenRouter / GitHub Models 等免费源；AI 配置集中在 `lib/ai/ai-config.ts` 的 `getAiConfig()`，支持 `AI_PROVIDER`=deepseek|openai，未设 `AI_API_KEY` 时回退 `DEEPSEEK_API_KEY`，密钥为空则进入「自动解释」模式）
- 关注股票、买卖记录、持仓与盈亏计算（买入/卖出自动按券商佣金费率估算手续费，卖出另计印花税 0.05%；支持单笔最低佣金与「免五」设置）
- 止盈止损提醒（前端轮询 + 可选 Cloudflare Cron 每 15 分钟主动推送通知）
- 公告摘要（支持上传 PDF / 链接，自动解析文本）
- 交易复盘（记录是否按计划、偏离原因、情绪、评分、备注）
- 策略扫描：本地 Python 量化脚本（trading_agent）跑选股/信号/回测，推送结果到云端，前端可视化
- 回写结果：trading_agent 中枢编排（run_hub.py）生成的候选信号，经云端审核后在「回写结果」页展示
- 全局浮窗 AI 对话助手：点击右下角浮动按钮，可在任意页面随时提问（支持绑定特定股票分析、组合持仓查询）
- 板块行情与个股主力资金流向查询
- 分析历史留存、数据导出（JSON / 备份）

## 本地运行

需要 Node.js 22.13 或更高版本（见 `package.json` engines）。

```bash
npm install
npm run dev      # 实际执行 vinext dev
```

> 本项目使用 `vinext`（Cloudflare 适配的 Next 构建工具）而非原生 `next`，`dev`/`build`/`start` 脚本均已映射。

访问终端显示的本地地址。登录与 AI 配置放在不会提交到 Git 的 `.env` 中（完整字段说明见 `.env.example`）：

```dotenv
# 必填（首次启动用以下两项自动创建超级管理员）
APP_USERNAME=owner
APP_PASSWORD=至少12位密码
APP_AUTH_SECRET=至少32位随机字符

DEEPSEEK_API_KEY=sk-xxxx
```

首次启动后，可用该超级管理员账号登录，在「设置 → 用户」中新建普通用户、指定角色或禁用账号。

不配置 AI 密钥时应用进入「自动解释」模式（无 AI 分析，其余功能正常）。

## 检查

```bash
npm run lint
npm test
```

## 常见问题

### `npm run dev` 报 `__dirname is not defined`

错误出现在 `@cloudflare/vite-plugin` 的 runner worker 中，通常是 Vite 依赖优化缓存与当前 lockfile 不一致导致。

**解决**：清除缓存后重启：

```powershell
# Windows PowerShell
Remove-Item -Recurse -Force node_modules/.vite
npm run dev
```

```bash
# macOS / Linux
rm -rf node_modules/.vite
npm run dev
```

### 依赖安装 / 版本问题

- 本项目 `package.json` 的 `engines` 要求 Node.js ≥22.13.0。
- 项目使用 `"type": "module"`（ESM），注意不要混用 CommonJS 语法。
- `package-lock.json` 已在 `.gitignore` 中忽略（跨平台二进制差异），部署时容器内重新 `npm install`。
- 若出现奇怪的运行时错误（特别是 workerd / miniflare 相关），可尝试 `rm -rf node_modules && npm install` 全量重装依赖。

## 部署

- Cloudflare Workers：使用 `worker/`（边缘入口）与 `build/`（`vinext build` 产物）。数据库为 D1，schema 由运行时 `ensureSchema()`（`db/index.ts`）幂等维护，不依赖迁移文件。
- Docker：使用 `Dockerfile`、`docker-compose.yml`、`start.sh` 和 `deploy.sh`。

### Docker 部署（Ubuntu 24 + Docker 26+）

前置条件（服务器上执行一次）：

```bash
sudo apt update && sudo apt install -y docker.io
sudo systemctl enable docker --now
sudo usermod -aG docker $USER && newgrp docker
sudo ufw allow 9003/tcp
```

首次部署：

```bash
git clone <repo> && cd <repo>
cp .env.example .env        # 填写必填配置项
chmod +x deploy.sh
./deploy.sh
```

后续更新（改完代码 push 后）：

```bash
git pull origin main
./deploy.sh
```

访问 `http://<服务器IP>:9003`。查看日志：`docker compose logs -f`；重启：`docker compose restart`；停止：`docker compose down`。数据（D1 与策略扫描结果）持久化在宿主机 `./data` 目录（容器重建不丢）。

### 部署提速说明（重要）

`deploy.sh` 使用 `docker compose build`（**不带 `--no-cache`**）+ BuildKit 缓存挂载，复用依赖安装层，避免每次重新 `npm install`：

- **只改源码的部署**：`node_modules` 层直接命中缓存，`npm install` 约 0 秒，仅重跑 `npm run build`。
- **改了 `package.json`**：依赖层失效并重装，但借助 `/root/.npm` 缓存挂载（`--prefer-offline`）只补下载变动的包，而非全量。
- 依赖安装用 `npm install`（在容器内按 Ubuntu 平台重新解析，不依赖 lock 文件）。`package-lock.json` 已在 `.gitignore` 中忽略（Windows 开发 / Ubuntu 部署，平台相关二进制 `esbuild`/`workerd`/`@webassemblyjs` 解析不同，不跨平台同步），故构建不强制 lock 与 `package.json` 一致，避免跨平台 `npm ci` 报 Missing/Invalid。

注意事项：

- **不要**在部署前运行 `docker builder prune -a` 或 `docker system prune`，否则会清空 npm 缓存挂载，重新变回全量下载。
- 想更新基础镜像（`node:22-bookworm`）的安全补丁时，偶尔跑一次 `docker compose build --pull` 即可。
- 若改了依赖却想强制重装（绕过缓存层），用 `docker compose build --no-cache`。

### 环境变量

完整配置项见 `.env.example`（模板，不含真实密钥）或 `.env`（本地实际值）。必填项（首次启动用 `APP_USERNAME`/`APP_PASSWORD` 自动初始化一个超级管理员，`APP_PASSWORD` 需 ≥12 位）：

| 变量 | 说明 |
|------|------|
| `APP_USERNAME` | 首次启动 seed 的超级管理员用户名（留空默认 `admin`） |
| `APP_PASSWORD` | 超级管理员密码（≥12 位，必填；首次启动校验） |
| `APP_AUTH_SECRET` | Session 签名密钥（≥32 位随机字符，生产用 `openssl rand -hex 32` 生成） |
| `DEEPSEEK_API_KEY` | DeepSeek API 密钥（不填则无 AI 分析） |

常用可选配置：

| 变量 | 说明 |
|------|------|
| `AI_PROVIDER` / `AI_API_KEY` / `AI_API_BASE` / `AI_MODEL` | 切换 OpenAI 兼容模型源（Ollama / OpenRouter 等） |
| `MAIRUI_TOKEN` | 麦蕊智数实时行情增强（免费档 500 次/日） |
| `NOTIFY_WEBHOOK_URLS` | 止盈/止损推送目标（企业微信/飞书/Bark，逗号分隔） |
| `CRON_SECRET` | 外部 Cron 调用鉴权密钥 |
| `STRATEGY_PUSH_TOKEN` | 策略扫描推送鉴权（本地 trading_agent → 云端） |
| `CLOUD_SCAN_URL` / `CLOUD_SCAN_TOKEN` | 云端扫描接收地址与令牌 |
| `CLOUD_WRITEBACK_URL` | 云端回写信号接收地址 |

更多可选变量（MCP 连接器、推送渠道、Docker 路径等）见 `.env.example` 中的注释说明。

## API 路由

所有 `/api/*` 路由均受 `lib/auth/auth.ts` 的 `requireApiUser` 保护（Cron 与策略推送除外，使用各自的 token）。鉴权函数包括：`requireApiUser`（返回 401 Response 或 null）、`requireSuperAdmin`（仅超级管理员，否则 403）、`requireApiUserOrPushToken`（读取类接口支持登录会话或 `x-push-token`/`Bearer` 任一通过）、`getCurrentUser`/`getAuthenticatedUser`。

| 路由 | 方法 | 说明 |
|------|------|------|
| `/api/auth/login` `/api/auth/logout` | POST / GET | 登录（formData）/ 登出（Cookie session） |
| `/api/me` | GET | 当前登录用户信息（含 `role`） |
| `/api/users` | GET / POST / PATCH / DELETE | 用户管理（超级管理员）：列出 / 新建（指定 `super_admin` 或 `user` 角色）/ 修改 / 删除用户 |
| `/api/trades` | GET / POST | 交易记录（POST 买入带 `maxLoss` 时自动建止损提醒） |
| `/api/watchlist` | GET / POST / PATCH / DELETE | 关注股票 |
| `/api/alerts` | GET / POST / PATCH / DELETE | 提醒规则（`PATCH action`: `disable`/`acknowledge`/`trigger`） |
| `/api/reviews` | GET / POST | 交易复盘 |
| `/api/account` | GET / PUT | 账户（初始资金 / 资金流水；`PUT action`: `initialCapital`/`create_flow`/`delete_flow`） |
| `/api/import` | POST | 仅接受 `{csv}` 原始文本，服务端解析券商导出 |
| `/api/export` | GET | 数据导出（JSON 备份） |
| `/api/analyze` | GET / POST | 股票分析（`POST {query, saveHistory, explain}`） |
| `/api/analysis-history` | GET / DELETE | 分析历史留存 |
| `/api/announcements` | GET / POST / DELETE | 公告（`POST` 用 FormData：symbol/name/title/file/sourceUrl，支持 PDF 解析） |
| `/api/assistant` | POST | 对话式复盘助手（支持上下文：持仓 + 当前股票分析） |
| `/api/market` | GET | 板块行情（`type=concepts`）与个股主力资金流（`type=fundflow&symbol=`） |
| `/api/quote` | POST | 轻量实时行情刷新（传入 `{symbols: string[]}`，单批最多 20 只，仅返回价格与涨跌幅），供前端轮询持仓/关注/提醒 |
| `/api/kline/[code]` | GET | 单只股票 K 线数据 |
| `/api/indices` `/api/sector-heatmap` | GET | 指数与板块热力图 |
| `/api/preferences` | GET / PUT | 用户偏好设置（交易风格、风险偏好、佣金费率、止损纪律等，见 `tradingPreferences` 表） |
| `/api/strategy-scan` | GET / POST | 策略扫描结果读取（GET）/ 本地 trading_agent 推送（POST，需 `x-push-token`） |
| `/api/strategy-scan/config` | GET / POST | 读取 / 保存选股默认配置（与 `strategy_config.yaml` 共用，前端「策略扫描」面板初始化表单；支持盘前/盘中/盘后分档） |
| `/api/strategy-scan/run` | POST | 按前端传入的配置覆盖参数重新跑引擎（调用 `trading_agent/run_hub.py`），支持本地 / 守护进程 / 云端沙箱三种运行环境 |
| `/api/writeback-signals` | GET / POST | 回写信号读取（GET）/ 本地 trading_agent 推送（POST，需 `x-push-token`） |
| `/api/feedback` | GET / POST | 策略反馈闭环：用户在前端对信号给出有效/无效评价（按用户隔离），用于优化策略权重 |
| `/api/feedback/optimize` | POST | 根据当前用户历史反馈（含因子明细）温和倾斜因子权重并写回云端 `strategy_config`（支持 `profile`: `pre_market`/`intraday`/`post_market`；样本不足 3 条不调整） |
| `/api/cron/check-alerts` | POST | 定时器入口：拉取实时价判断是否触发提醒并推送（需 `Authorization: Bearer <CRON_SECRET>`） |
| `/api/status` | GET | 运行状态 |

## 量化策略脚本（trading_agent/）

`trading_agent/` 是独立的 Python 模块，实现「选票 → 操作 → 回测 → 优化策略」闭环，使用真实 A 股公开接口（腾讯 / 东财，免 key）。详细文档见 `trading_agent/README.md`。

典型用法：

```bash
cd trading_agent

# 单次选股
python main.py                  # 默认：选 8 只 + 参数优化
python main.py --top-n 10       # 选出 10 只
python main.py --no-optim       # 跳过优化
python main.py --use-hot        # 同花顺当日强势股作候选池

# 中枢编排（定时/手动触发，自动串联选股→信号→推送）
python run_hub.py               # 一次跑完整流程，推送结果到云端

# 云端模拟器（本地调试云端接口，无需真实 Worker 服务）
python cloud_emulator.py        # 启动本地 HTTP 模拟（端口 8899）
```

### 本地引擎守护进程（前端「应用并扫描」联调）

`vinext dev` 的 API 路由跑在 Cloudflare Workers / Miniflare 沙箱中，无法直接执行 `child_process` 调起 Python，因此前端的「应用并扫描」按钮在本地开发时无法在沙箱内跑引擎。为此提供真实 Node 守护进程作为桥接：

```bash
# 另开一个终端，在项目根目录启动本地引擎守护进程
npm run engine                  # 实际执行 node trading_agent/local_engine_server.js
```

守护进程监听 `127.0.0.1:8787`（可用 `LOCAL_ENGINE_PORT` / `LOCAL_ENGINE_HOST` 覆盖），收到请求后用真实 Node 调起 `python run_hub.py` 跑引擎，再把 `scan_payload.json` 回传。前端 `POST /api/strategy-scan/run` 检测到处于沙箱环境时，会自动把请求转发到该守护进程。

> 在原生 `node` 部署（非沙箱）时，`SUPPORTS_EXEC` 为真，API 直接 `exec` Python，无需启动守护进程。云端 Workers 环境则直接返回 `CLOUD_ENGINE_DISABLED`，选股改由本地程序拉取云端配置后运行。

### 数据流向

```
本地 PC (trading_agent)
  │
  ├─ main.py / run_hub.py ──选股/信号──► POST /api/strategy-scan ──► 前端「策略扫描」视图
  │
  ├─ run_hub.py ──候选回写──► POST /api/writeback-signals ──► 前端「回写结果」视图
  │
  └─ 用户在「策略扫描」页标记有效/无效 ──► POST /api/feedback ──► 因子权重
        │                                                       （按用户隔离）
        └─ 点「用反馈优化权重」──► POST /api/feedback/optimize ──► 写回云端 strategy_config
              （下次 run_hub 拉取配置自动应用新权重，无需改 Python 引擎）
```

该模块通常在**本地 PC** 运行，跑完选股/信号/回测后，将结果 POST 到云端的对应接口（带 `x-push-token`，值等于云端的 `STRATEGY_PUSH_TOKEN`）。结果为历史数据分析/回测/模拟，不构成投资建议。**回写默认 `dry_run=True`** 安全，真实下单需显式 `enable_writeback` 且 `dry_run=False`（需接入带下单能力的连接器）。

### 可选数据源扩展

`trading_agent` 默认走腾讯/东财免费公开接口。也可接入以下 MCP 连接器获取增强数据：

- **腾讯自选股 MCP**（`WESTOCK_MCP_URL` / `WESTOCK_MCP_TOKEN`）：行情 / K 线 / 财务查询
- **通达信 MCP**（`TDX_MCP_URL` / `TDX_API_KEY`）：行情 + 条件选股 + 交易接口
- **WorkBuddy 网关**（`WORKBUDDY_GATEWAY_URL`）：增强行情数据

在 `.env` 中填入对应 URL 和 Token 即可启用。

## 前端与组件

- 单页应用：登录页 `app/login/page.tsx`（视觉化卡片，提交到 `/api/auth/login`）；主应用 `app/page.tsx`（服务端校验登录后渲染 `app/Dashboard.tsx`）。
- 视图状态机 `view ∈ home | analysis | watchlist | trades | settings | analytics | strategyScan | writeback`；分析页由 `app/AnalyticsView.tsx` 渲染，回写结果页由 `app/WritebackView.tsx` 渲染。`settings` 含 `account`/`alerts`/`users` 等分区，用户管理（`UsersAdmin`）仅超级管理员可见。
- 全局浮窗 AI 助手 `FloatingAssistantLauncher`：右下角浮动按钮，展开后支持绑定股票分析、组合持仓查询，选股下拉框自动合并关注列表与最近分析历史。
- 对话式复盘助手 `SmartAssistant`：分析页内嵌使用，调用 `/api/assistant`，支持分析上下文自动注入。
- 组件库统一封装在 `app/components.tsx`，样式由 `app/globals.css` 的语义化 class + CSS 变量驱动；已引入 Tailwind v4（`@tailwindcss/postcss`）。
- 图表使用 `lightweight-charts`；分析页导出 PDF 用 `html-to-image` + `jspdf`（动态 import）。
- 金额统一以整数存储（`priceMillis` ×1000 为主，旧数据可能仅 `priceCents` ×100），前端避免散落浮点金额计算，格式化集中在 `lib/format.ts`。

数据库 schema 由 `db/index.ts` 的 `ensureSchema()` 运行时幂等维护（建表/加列/建索引），不依赖迁移文件；`drizzle/` 与 `drizzle-kit` 已废弃，禁止再运行 `drizzle-kit generate`。
