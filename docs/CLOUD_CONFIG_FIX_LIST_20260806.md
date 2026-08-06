# 云端策略配置修复清单（2026-08-06）

> 适用对象：云端服务器 120.48.87.170:9003 的「选股配置」页（strategy_config 表，三档 Tab）。
> 本清单对应本地代码已完成的引擎/预设/技能修复，**云端配置不改，三档实际行为仍会跑偏**。
> 操作入口：网页「选股配置」→ 对应档位 Tab（盘前 pre_market / 盘中 intraday / 盘后 post_market）→ 保存。

---

## 背景（审查结论摘要）

本地引擎审查发现 4 个根因导致「选出的股票不对味」：

1. **候选池与策略错配**：候选池固定用腾讯自选股 low_pe 低估值池（银行/保险/基建为主），
   无论选超跌/突破/游资策略都只能在低估值蓝筹里矮子拔将军。（已修：技能/自动化按档位切换活跃池，见下）
2. **RSI 因子方向 bug**：超跌类预设（bottom_reversal）的 RSI 因子方向与意图相反，
   选出 RSI 70+ 的超买追高票而非超跌票。（已修：新增 `rsi_direction` 反转开关，引擎实测生效）
3. **市场风控被云端配置关闭**：云端三档 `market.enable=false` 静默覆盖本地 YAML 的 true，
   牛熊判定永远 unknown、仓位恒 1.0（熊市也会满仓选股）。→ **本清单第 1 项**
4. **云端档位配置与 UI 标注的预设不符**：盘后档 UI 标注 ma_golden（均线多头），
   云端实际权重却是超跌反弹风格（RSI 0.36/MACD 0.26），用户以为跑 A 实际跑 B。→ **本清单第 2 项**

---

## 需要你在云端「选股配置」页修改的项目

### 1. 三档统一：启用市场风控（market.enable = true）

| 档位 | 字段 | 当前值 | 改为 |
|---|---|---|---|
| pre_market | market.enable | false | **true** |
| intraday | market.enable | false | **true** |
| post_market | market.enable | false | **true** |

> 影响：run_hub 启动后按沪深300（000300）判定牛/中性/熊，
> 熊市选股数归零（空仓），中性半仓（top_n 减半），牛市满仓。
> 本地 YAML 的 `market.enable: true` 一直是开的，是云端 false 覆盖了它。

### 2. 盘后档：权重对齐「均线多头」预设（当前是超跌反弹风格）

盘后档 UI 与报告标注 preset=ma_golden（均线多头、次日观察池），但云端实际权重是
bottom_reversal 风格。请把 post_market 档的因子权重改为：

| 字段 | 当前值（≈超跌反弹） | 改为（= ma_golden 预设） |
|---|---|---|
| w_trend | 0.06 | **0.38** |
| w_momentum | 0.14 | **0.26** |
| w_liquidity | 0.08 | **0.14** |
| w_rsi | 0.36 | **0.12** |
| w_macd | 0.26 | **0.06** |
| w_value | 0.04 | **0.02** |
| w_size | 0.0 | **0.02** |
| w_quality | 0.0 | **0.0** |
| w_fund_flow | 0.06 | **0.0** |
| fast_ma | 5 | **5** |
| slow_ma | 20 | **10**（ma_golden 用 5/10 金叉） |

### 3. 三档核对：top_n 与 max_positions 对齐

| 档位 | top_n | max_positions | 说明 |
|---|---|---|---|
| pre_market | 3 | 8 | 建议 top_n 提到 **8**，否则只选 3 只偏少 |
| intraday | （核对） | （核对） | 建议 top_n=5、max_positions=5 |
| post_market | 10 | 8 | 建议 top_n=**8**、max_positions=8 |

> 现状：post_market top_n=10 但 max_positions=8，信号会多出 2 笔超过持仓上限。

### 4. 盘前档：momentum_window 与预设一致（防止「动量显示异常」）

本地预设 breakout 用 momentum_window=20；实测云端 pre_market 档把 momentum_window 覆盖成了
较大值（导致朗姿股份动量从 28.7% 显示成 3.4%）。请核对并改回：

| 档位 | 字段 | 当前值 | 改为 |
|---|---|---|---|
| pre_market | momentum_window | （核实，较大） | **20** |
| pre_market | min_turnover_pct | （核实） | **1.0**（突破需活跃换手） |

---

## 本地已完成（无需你操作）

- `strategy/screener.py`：新增 `rsi_direction` 反转开关（reversal 偏好 RSI 30~50）。
- `strategy/presets.py`：16 个预设精简为 **8 个核心**（删除 hot_theme/first_limit_up/
  high_volatility_play/divergence_reversal/northbound_resonance/limit_up_streak/
  afternoon_close/morning_breakout）；bottom_reversal 预设声明 `rsi_direction: "reversal"`；
  每个预设新增 `universe_filter` 字段（low_pe / active）供候选池匹配。
- 前端 `ScreenerConfigPanel.tsx`：STRATEGY_PRESETS 同步精简为 8 个；支持 rsi_direction 字段。
- 技能与自动化：stock-pick-hub / daily-stock-screener 及三条自动化 prompt 已按档位切换候选池：
  - 盘前（breakout）→ 活跃池 `TURNOVER_RATE > 1`
  - 盘中（momentum_chase）→ 活跃池 `TURNOVER_RATE > 2`
  - 盘后（ma_golden）→ 活跃池 `TURNOVER_RATE > 0.3`
  - 保守类（value_defensive / dividend_cashflow）→ low_pe
- 本地 `strategy_config.yaml`：新增 `rsi_direction: normal` 注释与默认值。

## 验证方式（改完云端后）

下个交易日盘前自动跑批后，检查报告「策略快照」段：
- market.enable 应为 **true**，牛熊判定不再是 unknown/仓位 1.0；
- post_market 权重应显示 trend 0.38 为主（均线多头）；
- 候选池来源应显示「活跃池（TURNOVER_RATE>1）」而非 low_pe；
- 超跌反弹预设选出的票 RSI 应落在 30~55（修复前是 62~76）。
