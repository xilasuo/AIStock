# 选股中枢编排 · 分享与部署指南

把「每日选股中枢编排（盘前·邮箱+企业微信推送）」自动化，从你的 WorkBuddy 迁移到**另一个人的 WorkBuddy** 上独立运行。

> ⚠️ 重要前提：当前 WorkBuddy **没有**"一键分享 / 导出自动化"的原生功能。自动化只存在本机数据库里。所以"发给别人"= 把下面三样东西交给对方，由他在自己的 WorkBuddy 上重建。

## 你要发给对方的三样东西
1. **代码**：`trading_agent` 整个目录（纯 Python 引擎，stdlib-only，无第三方依赖）。
2. **编排配置**：`automation_prompt.txt`（自动化的 prompt）+ 定时规则 + 工作目录（见 `automation_create.json`）。
3. **部署说明**：本文件。

## 一、发送方（你）要做的事
1. **给代码**：让对方能拿到 `trading_agent` 代码。两种方式任选：
   - 推荐：给对方 git 读权限，对方克隆 `https://github.com/xilasuo/AIStock.git`（branch `main`），取 `trading_agent/` 子目录即可。
   - 或：把 `trading_agent/` 整个目录打包（zip）发过去。**注意**：`trading_agent` 不含 `.env`（凭据），但请确认包里没有 `prefetched.json` / `scan_payload.json` 等含你本地数据的运行产物（非机密，但没必要传）。
2. **发配置**：把本目录（`share-stock-hub/`）整体发过去——里面有 `automation_prompt.txt` 和 `automation_create.json`。
3. **决定凭据策略**（见下方"凭据与安全"），并告知对方。

## 二、接收方（对方）要做的事
### 1. 准备代码
- 克隆 / 解压得到 `trading_agent` 目录，记下它的绝对路径，下文记为 `{{TA_DIR}}`（例如 `D:/code/AIStock/trading_agent` 或 `/home/user/AIStock/trading_agent`）。

### 2. 连接连接器（在他自己的 WorkBuddy）
- 打开连接器面板，把 **通达信 (tdx-connector)** 和 **腾讯自选股 (westock-mcp)** 都"信任 / 连接"上。这两个是自动化的数据源，必须连。
- 打开 **智能体邮箱 (agent-mail)**，在「更多 - 我的邮箱」里开通并绑定他自己的邮箱（结果会推到他自己的邮箱）。

### 3. 准备 Python
- 确认本机有 Python 3.10+。记下可执行文件路径 `{{PY_BIN}}`：
  - 若用 WorkBuddy 托管 Python：`C:/Users/<他用户名>/.workbuddy/binaries/python/versions/3.13.12/python.exe`（Windows）或对应路径。
  - 否则直接填 `python3`。
- `trading_agent` 是纯标准库，无需 `pip install`。

### 4. 配置 .env（关键）
- 在 `{{TA_DIR}}` 的**上级项目目录**放一个 `.env`（KEY=VALUE 格式），包含以下键：
  - `CLOUD_BASE_URL` / `CLOUD_CFG_USER` / `CLOUD_CFG_PASS`：云端策略配置服务地址与账号。
  - `CLOUD_SCAN_URL` / `CLOUD_SCAN_TOKEN`：扫描结果回写地址与令牌。
  - `CLOUD_WRITEBACK_URL`：（可选）候选信号回写地址。
  - `WECOM_WEBHOOK_URL`：企业微信群机器人 webhook（结果会推到这个群）。
  - 其余 `WX_PUSH_DRIVER` / `SERVERCHAN_KEY` / `PUSHPLUS_TOKEN` 为备用推送通道，可留空。
- ⚠️ `automation_prompt.txt` 里 `{{ENV_FILE}}` 要改成这个 `.env` 的**绝对路径**。

### 5. 重建自动化
两种方式任选：
- **方式 A（UI）**：在 WorkBuddy 自动化入口新建自动化，名称填「每日选股中枢编排（盘前·邮箱+企业微信推送）」，把 `automation_prompt.txt` 整段粘进 prompt 框，定时规则填 `FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=8;BYMINUTE=0`，工作目录填 `{{TA_DIR}}`，保存并启用。
- **方式 B（让我建）**：在 WorkBuddy 对话里说"按 automation_create.json 创建一个自动化"，并把 `automation_prompt.txt` 内容贴进去（把 `{{TA_DIR}}` 换成真实路径）。

### 6. 替换占位符（必须）
`automation_prompt.txt` 里有 3 个占位符，接收方必须改成自己的真实值：
- `{{ENV_FILE}}` → 他的 `.env` 绝对路径
- `{{PY_BIN}}` → 他的 Python 可执行路径
- `{{TA_DIR}}` → 他的 `trading_agent` 目录绝对路径

## 三、凭据与安全（务必先决定）
- **各自独立运行（推荐）**：对方用**他自己**的云端账号、企业微信机器人、智能体邮箱。双方互不影响，凭据不外泄。对方需自行准备 `CLOUD_*` 与 `WECOM_WEBHOOK_URL`。
- **共用同一套基础设施**：如果你想让对方的运行结果也回写进**你的**云端 / 推到**你的**企业微信群，就把你的 `CLOUD_*` 和 `WECOM_WEBHOOK_URL` 直接告诉他，填进他的 `.env`。⚠️ 这意味着你把相关凭据交给了对方，请确认你信任他、且这些凭据可共享。

## 四、验证
- 让对方手动触发一次该自动化（不修改任何东西，直接跑），看是否：候选池有数据 → prefetched.json 生成 → scan_payload.json 生成 → 邮箱收到 → 企微群收到。
- 若候选池为 0 / 推送失败，先核对他是否连了连接器、`.env` 路径与键值是否正确、占位符是否替换。

## 五、定时说明
- 当前规则：周一至周五 **08:00**（盘前）。如需改时间，改 `rrule` 的 `BYHOUR` / `BYMINUTE` 即可。
- 注意：自动化依赖交易日盘面数据，周末 / 节假日运行时可能返回空或风控空仓，属正常。
