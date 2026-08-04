# 多用户隔离改造 · 部署核对清单

> 用途：服务器 `git pull && ./deploy.sh` 重建后，逐项验证「选股配置 / 选股结果 / 回写结果」三层用户隔离是否真正生效。
> 关联改造 commit（均已推送 `origin/main`）：
> - `3db8f0a` 选股**配置**按用户隔离（`strategy_config` 加 `user_id`）
> - `a219a41` 选股**结果**按用户隔离（`strategy_scan` 加 `user_id`）
> - `db0226e` 回写**结果**按用户隔离（`strategy_writeback` 加 `user_id`）

---

## 一、部署前准备（本机）

1. 本机已 `git push origin main`（4 个提交：`3db8f0a` + `a219a41` + `db0226e` + docs）。
2. 确认 `.env` 里 `CLOUD_CFG_USER` / `CLOUD_CFG_PASS` 指向**期望的账号**（本地盘前自动化会用它登录，从而落到该账号名下的隔离数据）。
   - 当前配的是 `admin` → 本地结果归 admin。
   - 想让本地结果归你本人：在网页用你本人账号登录并保存一次配置，再把 `.env` 改成你本人账号。

## 二、服务器重建

```bash
cd <项目目录>
git pull origin main
./deploy.sh          # docker compose build --no-cache + up -d --force-recreate
```

重建后**首次请求** `ensureSchema()` 会自动执行：
- `ALTER TABLE strategy_config  ADD COLUMN user_id INTEGER`
- `ALTER TABLE strategy_scan   ADD COLUMN user_id INTEGER`
- `ALTER TABLE strategy_writeback ADD COLUMN user_id INTEGER`

老库已有数据 `user_id=NULL`，**自动成为「全局默认」回退**，不会丢数据，无需手动迁库。

## 三、数据库迁移自检

重建后访问任意接口触发 `ensureSchema`，然后确认列已存在（任选其一）：
- 云端 D1 控制台 / `wrangler d1 execute` 执行 `SELECT user_id FROM strategy_config LIMIT 1;` 不报 "no such column" 即通过。
- 或直接跑下方「验证」：若接口正常返回、且 `scope` 字段出现，说明迁移成功。

## 四、逐项验证（curl，替换 `<SERVER_URL>` 为 `http://120.48.87.170:9003`）

### 0. 准备：登录取会话 cookie

```bash
# 用户 A（如 admin）
curl -c /tmp/cookieA.txt -X POST '<SERVER_URL>/api/auth/login' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data 'username=admin&password=<ADMIN_PASS>'

# 用户 B（另一个账号，若有多用户场景）
curl -c /tmp/cookieB.txt -X POST '<SERVER_URL>/api/auth/login' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data 'username=<USERB>&password=<USERB_PASS>'
```
> 返回 303 + `set-cookie: stock_assistant_session=...` 即登录成功，cookie 落入对应 jar。

### 1. 选股配置隔离（strategy_config）

```bash
# A 登录态保存一份配置
curl -b /tmp/cookieA.txt -X POST '<SERVER_URL>/api/strategy-scan/config' \
  -H 'Content-Type: application/json' \
  -d '{"top_n":7,"preset":"breakout","market_enable":true}'

# A 读 → 应返回 A 刚存的，且含 "scope":"user"
curl -b /tmp/cookieA.txt '<SERVER_URL>/api/strategy-scan/config'

# B 读 → 不应返回 A 的 top_n=7（B 未保存过则回退全局默认 scope=global）
curl -b /tmp/cookieB.txt '<SERVER_URL>/api/strategy-scan/config'
```
✅ 判定：A 读到 `scope:"user"` 且 `top_n=7`；B 读到的是默认/全局，互不覆盖。

### 2. 选股结果隔离（strategy_scan）

```bash
# A 以登录态推送一份结果（带 cookie，写 user_id=A）
curl -b /tmp/cookieA.txt -X POST '<SERVER_URL>/api/strategy-scan' \
  -H 'Content-Type: application/json' \
  -d '{"generatedAt":"2026-08-04T09:00:00+08:00","stocks":[{"code":"600000","name":"浦发银行","score":9.1}]}'

# A 读 → 应看到 A 推的浦发银行
curl -b /tmp/cookieA.txt '<SERVER_URL>/api/strategy-scan'

# B 读 → 不应看到浦发银行（B 有本人数据则只看到 B 的；B 无数据则回退全局桶）
curl -b /tmp/cookieB.txt '<SERVER_URL>/api/strategy-scan'
```
✅ 判定：A 登录看到浦发银行；B 登录**不**看到（除非 B 本人也推了，那是另一条）。

### 3. 回写结果隔离（strategy_writeback）

```bash
curl -b /tmp/cookieA.txt -X POST '<SERVER_URL>/api/writeback-signals' \
  -H 'Content-Type: application/json' \
  -d '{"generatedAt":"2026-08-04T09:00:00+08:00","signals":[{"code":"600000","action":"buy"}]}'

curl -b /tmp/cookieA.txt '<SERVER_URL>/api/writeback-signals'   # 应看到 A 的
curl -b /tmp/cookieB.txt '<SERVER_URL>/api/writeback-signals'   # 不应看到 A 的
```
✅ 判定：同选股结果。

### 4. 安全：仅持共享 token（无登录）→ 只能写全局桶，禁伪造他人

```bash
# 仅带 x-push-token，不带 cookie：写入 user_id=NULL 的全局桶
curl -X POST '<SERVER_URL>/api/strategy-scan' \
  -H 'Content-Type: application/json' \
  -H 'x-push-token: <STRATEGY_PUSH_TOKEN>' \
  -d '{"generatedAt":"2026-08-04T09:30:00+08:00","stocks":[{"code":"000001","name":"平安银行","score":5.0}]}'
```
✅ 判定：
- 该数据 `user_id=NULL`（全局桶），任何**未保存本人数据**的用户登录后都会回退看到它。
- **无法**通过 token 把数据写成某个具体 `user_id`（后端只在「登录会话」下才写本人 id，token 路径强制 NULL）。即他人无法伪造/污染你的隔离结果。

## 五、前端验证

1. 浏览器用账号 A 登录 → 「策略扫描」页只显示 A 本人最近推送的结果。
2. 退出，用账号 B 登录 → 「策略扫描」「回写结果」两页只显示 B 本人的，不串 A 的。
3. 本地盘前自动化跑一次后，用 `.env` 对应账号登录网页，应能立刻看到本次推送的本人结果。

## 六、回退与排错

| 现象 | 原因 | 处理 |
|---|---|---|
| GET 配置返回 `401` | 未带登录 cookie / cookie 过期 | 重新走 §0 登录；本地 `.env` 的 `CLOUD_CFG_PASS` 必须等于云端账号真实密码 |
| 前端看到「别人的」结果 | 本人从未推送过，回退显示了 `user_id=NULL` 全局桶 | 预期行为；本人以登录态推送一次即锁定本人数据 |
| 迁移报 "no such column" | `ensureSchema` 未触发 / 容器未重建 | 确认已 `./deploy.sh`；手动访问一次接口触发迁移 |
| 本地配置被「莫名」改变 | `.env` 未配账号 → 回退本地 YAML；或云端该账号被改 | 检查 `cloud_strategy_receipt.json` 的 `source` 字段 |

## 七、预期行为速查

| 场景 | 写入 `user_id` | 读取可见范围 |
|---|---|---|
| 网页登录后保存/推送 | 本人 id | 仅本人（优先本人行） |
| 本地自动化（带登录 cookie）推送 | 本人 id（=`.env` 账号） | 仅本人 |
| 仅持共享 token 推送（兼容老链路） | `NULL`（全局桶） | 所有「无本人数据」的用户回退可见 |
| 用户从未推送 | — | 回退看全局桶（NULL 行） |

---
`STRATEGY_PUSH_TOKEN` 与 `CLOUD_SCAN_TOKEN` 同值（服务端 `STRATEGY_PUSH_TOKEN` env）。
