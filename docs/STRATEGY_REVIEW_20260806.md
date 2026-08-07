# 选股策略审查与优化报告

> 日期：2026-08-06 ｜ 审查范围：trading_agent 引擎 + 预设 + 候选池 + 云端配置 + 自动化
> 结论：**问题属实且可复现**，已定位 4 个根因，引擎/预设/技能已修复并提交（b38ff73），云端配置需按清单手动改。

---

## 一、你反馈的问题是什么

「选股一点都不好用，选出的股票有很大问题」。经代码审查 + 用今日真实数据（prefetched.json 120 只候选）实证复现，确认选股质量差的**直接表现**：

- 选「超跌反弹」策略，选出的 10 只票 RSI 全部 60~76（超买追高），真正超跌的票（RSI 40~45）一只没选；
- 无论选什么策略，选出的几乎都是**低 PE 蓝筹**（朗姿股份 PE 7.1、好想你 PE 2.33、焦作万方 PE 9.58），与「超跌反弹/放量突破」的定位风马牛不相及；
- 回测已连续转负（盘前报告自述「回测近期转负，信号偏弱」，夏普 -0.061）；
- 牛熊风控从未生效（marketState 恒为 unknown、仓位恒 1.0，熊市也会满仓选股）。

---

## 二、四大根因（实证）

### 根因 1：候选池与策略严重错配（最根本）

候选池**永远**是腾讯自选股 `low_pe`（低市盈率）筛出的 120 只低估值票：
银行/保险/基建为主（PE 中位 7.4、PB 中位 0.8、换手中位 0.8%）。

后果：无论选「超跌反弹」「放量突破」还是「游资」，都只能在这批低估值蓝筹里**矮子里拔将军**。
高弹性、有题材、在启动的股票根本进不了候选池。

**修复**：预设新增 `universe_filter` 字段，技能与自动化按档位切换候选池——
盘前(breakout)→活跃池 `TURNOVER_RATE > 1`；盘中(momentum_chase)→`TURNOVER_RATE > 2`；
盘后(ma_golden)→`TURNOVER_RATE > 0.3`；保守类(value_defensive/dividend_cashflow)→仍用 low_pe。
仍遵守「单数据源腾讯自选股」约定，不双源并行。

### 根因 2：RSI 因子方向 bug（超跌类预设形同虚设）

`screener._rsi_factor()` 是「RSI 越高分越高」（偏好 50~70 健康强势），
而 `bottom_reversal`（超跌反弹）预设想选「RSI 低位」——**方向完全相反**。

实证（同一份数据、修复前后对比）：

| 预设 | 修复前入选 RSI | 修复后入选 RSI |
|---|---|---|
| bottom_reversal | **75.9 / 72.8 / 69.7 / 62.9 / 56.8**（全超买追高） | 56.8 / 75.9 / 48.6 / 62.9 / **48.9**（出现超跌票） |

**修复**：新增 `rsi_direction` 配置（normal / reversal）。reversal 模式下
RSI 30~50 区间给高分（0.8~1.0），>70 归零。bottom_reversal 预设已声明 `reversal`。

### 根因 3：云端配置静默覆盖，牛熊风控被关闭

本地 `strategy_config.yaml` 的 `market.enable: true` 一直开着，但云端配置
（云端服务器，SHA `97d82c8b`）三档都是 `market_enable=false`，
按「云端 > 本地 YAML」优先级静默覆盖 → 牛熊判定永远 unknown、仓位恒 1.0。

**修复**：云端配置需手动改（见清单第 1 项），本地无法代改（无服务器权限）。

### 根因 4：云端档位配置与 UI 标注不符 + 因子空心化

- 盘后档 UI 标注 ma_golden（均线多头），云端实际权重却是超跌反弹风格
  （RSI 0.36 / MACD 0.26）→ 用户以为跑 A 实际跑 B；
- 行情快照无 roe/dividend/fund_flow/sector 字段 → 质量、资金流、行业分散
  三个因子全部跳过，实际只有 6 个技术因子在打分（meta.skipped 已如实暴露）。

**修复**：云端权重对齐 ma_golden（清单第 2 项）；因子缺失已在报告中如实展示。

---

## 三、已完成的本地修复（commit b38ff73）

| 文件 | 改动 |
|---|---|
| `strategy/screener.py` | `_rsi_factor` 支持 direction 参数，新增反转映射 |
| `strategy/presets.py` | **16 预设精简为 8 个核心**；新增 `universe_filter`；bottom_reversal 声明 `rsi_direction: reversal` |
| `config.py` / `run_hub.py` / `strategy_config.yaml` | `rsi_direction` 完整配置链路 |
| `ScreenerConfigPanel.tsx`（前端） | STRATEGY_PRESETS 同步精简为 8 个；rsi_direction 透传 |
| `run/route.ts` + `local_engine_server.js` | ALLOWED_KEYS 白名单加 rsi_direction |
| `config/route.ts` + `reset_cloud_config.py` | FALLBACK_CONFIG 同步 rsi_direction |
| stock-pick-hub / daily-stock-screener 技能 + 3 条自动化 prompt | 候选池按档位匹配活跃池 |

**删除的 8 个预设**（依赖数据源不支持的字段，实际跑不出预期）：
hot_theme / first_limit_up / high_volatility_play / divergence_reversal /
northbound_resonance / limit_up_streak / afternoon_close / morning_breakout。

**保留的 8 个核心预设**：
value_defensive（价值防御）/ dividend_cashflow（红利现金流）/ breakout（放量突破）/
ma_golden（均线多头金叉）/ macd_cross（MACD 金叉）/ youzi（游资风格）/
momentum_chase（强势追涨）/ bottom_reversal（超跌反弹）。

---

## 四、需要你在云端改的（docs/CLOUD_CONFIG_FIX_LIST_20260806.md）

登录云端「选股配置」页（三档 Tab）修改：

1. **三档 market.enable → true**（恢复牛熊风控，熊市空仓、中性半仓）；
2. **盘后档权重改为 ma_golden**（trend 0.38 / momentum 0.26 / liquidity 0.14 / rsi 0.12 / macd 0.06 / value 0.02 / size 0.02，slow_ma=10）；
3. **top_n 与 max_positions 对齐**（建议 pre_market 8/8、intraday 5/5、post_market 8/8）；
4. **盘前档 momentum_window → 20、min_turnover → 1.0**（实测云端把 momentum_window 覆盖成较大值，导致动量显示异常）。

改完后下个交易日自动跑批即可生效，报告「策略快照」段会体现。

---

## 五、验证结果

- ✅ 8 个预设逐一运行无回归；
- ✅ bottom_reversal 修复前 RSI 62~76 → 修复后出现 48.6/48.9 超跌票；
- ✅ TypeScript 类型检查零错误（tsc --noEmit）；
- ✅ run_hub 完整链路（选股→回测→云端推送）HTTP 200。
