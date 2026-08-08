"""经典短线选股策略预设

每个预设是一组 screener / signal 的「权重 + 阈值」覆盖值（overrides）。
它与现有多因子引擎解耦：引擎仍按 8 因子打分，预设只是把权重/阈值
调成对应风格。新增策略只需在此追加条目，前端/CLI/API 三处自动生效。

使用方式：
  - 命令行：run_hub.py --overrides '{"preset":"breakout"}'
  - API    ：POST /api/strategy-scan/run   body 含 "preset":"breakout"
  - 前端    ：配置面板「策略预设」下拉框

优先级（低 -> 高）：
  prefetched 内嵌 config  <  预设基线(preset)  <  前端/CLI 显式覆盖字段

⚠️ 候选池匹配（2026-08-06 优化）：
  每个预设带 `universe_filter` 字段 = 该策略**期望的候选池筛选条件**
  （腾讯自选股 tool_filter 的 preset 名或 expression）。中枢在步骤 2
  生成候选池时应按当前策略的 universe_filter 选择筛选条件，避免
  「超跌/游资策略在低估值蓝筹池里矮子拔将军」的错配。
  引擎本身不消费该字段（候选池由中枢生成后经 prefetched.json 注入）。

⚠️ RSI 方向（2026-08-06 修复）：
  `rsi_direction` 控制 screener 的 RSI 因子方向：
    normal   = 偏好 50~70 健康强势（趋势/动量类策略）
    reversal = 偏好 30~50 超跌反弹（bottom_reversal 等超跌类）
  超跌类预设必须显式声明 reversal，否则选出的全是超买追高票。
"""
from __future__ import annotations


# 选股预设集合，按风险档（risk）统一标注，与交易纪律风险偏好 riskProfile
# （conservative/balanced/aggressive）对齐：
#   conservative（保守）：低波动 + 重估值/质量/规模，避开高换手追涨，求稳。
#   balanced（平衡）    ：经典趋势/动量/动能策略，风险适中。
#   aggressive（激进）  ：高动量 + 高换手 + 放开估值，追涨/超跌/题材，波动大。
# 每套预设新增 "risk" 字段用于前端分组与展示；前端
# app/ScreenerConfigPanel.tsx 的 STRATEGY_PRESETS 须与本字典保持同步，
# 否则 CLI/API 直接按 preset 名调用会找不到预设、参数丢失退回默认。
# 注：打板/连板等需实时涨停盘口数据的策略，引擎暂无对应因子，用「高换手+强动量」近似。
#
# 2026-08-06 精简：从 16 个删至 8 个核心预设。删除的 8 个
# （hot_theme/first_limit_up/high_volatility_play/divergence_reversal/
#  northbound_resonance/limit_up_streak/afternoon_close/morning_breakout）
# 均严重依赖当前数据源不支持的字段（涨停盘口/北向/资金流/分时），
# 实际跑不出预期效果，且与候选池风格错配放大失真。前端 STRATEGY_PRESETS 已同步。
STRATEGY_PRESETS: dict[str, dict] = {
    # —— 保守策略（低风险：重估值/质量/规模，低波动，避开追涨）——
    "value_defensive": {
        "label": "价值防御",
        "risk": "保守",
        "desc": "保守：重估值 + 质量 + 大市值，低动量/低换手，宽止损，避开高波动与题材炒作。适合稳健底仓。",
        "universe_filter": "low_pe",   # 候选池：低估值（与策略匹配）
        "overrides": {
            "w_value": 0.30,
            "w_quality": 0.28,
            "w_size": 0.20,
            "w_trend": 0.12,
            "w_momentum": 0.06,
            "w_rsi": 0.02,
            "w_macd": 0.02,
            "w_liquidity": 0.00,
            "w_fund_flow": 0.00,
            "momentum_window": 60,       # 长回看，过滤短炒
            "max_pe_ttm": 25,            # 低估上限（保守，不追高估值）
            "max_pb": 3.0,
            "min_turnover_pct": 0.15,    # 低换手门槛，避开活跃游资票
            "top_n": 8,
            "max_per_sector": 2,
            "st_filter": "exclude_st",
            "use_breakout_filter": False,
            "stop_loss_pct": -0.12,      # 宽止损，给价值票更多容错
        },
    },
    "dividend_cashflow": {
        "label": "红利现金流",
        "risk": "保守",
        "desc": "保守：重质量（ROE/股息）+ 低波动 + 低估值，优选现金流稳定的蓝筹，少交易、求稳。",
        "universe_filter": "low_pe",
        "overrides": {
            "w_quality": 0.42,
            "w_value": 0.22,
            "w_size": 0.18,
            "w_trend": 0.10,
            "w_rsi": 0.04,
            "w_momentum": 0.02,
            "w_macd": 0.02,
            "w_liquidity": 0.00,
            "w_fund_flow": 0.00,
            "momentum_window": 60,
            "max_pe_ttm": 20,
            "max_pb": 2.5,
            "min_turnover_pct": 0.15,
            "top_n": 8,
            "max_per_sector": 1,
            "st_filter": "exclude_st",
            "use_breakout_filter": False,
            "stop_loss_pct": -0.12,
        },
    },
    "breakout": {
        "label": "放量突破",
        "risk": "平衡",
        "desc": "强调动量 + 量能，要求活跃换手，捕捉横盘后放量突破前高。",
        "universe_filter": "active",     # 候选池：活跃换手（非低估值池）
        "overrides": {
            # 因子权重（运行时归一化）
            "w_momentum": 0.40,
            "w_liquidity": 0.22,
            "w_trend": 0.16,
            "w_rsi": 0.10,
            "w_macd": 0.08,
            "w_value": 0.02,
            "w_size": 0.02,
            "w_quality": 0.00,
            "w_fund_flow": 0.00,
            # 阈值 / 参数
            "momentum_window": 20,
            "min_turnover_pct": 1.0,       # 要求活跃换手，过滤无量假突破
            "use_breakout_filter": True,   # 信号侧：突破 N 日新高才买入
            "breakout_window": 20,
        },
    },
    "ma_golden": {
        "label": "均线多头金叉",
        "risk": "平衡",
        "desc": "趋势跟随：重趋势 + 动量，快/慢均线 5/10 金叉确认。",
        "universe_filter": "active",
        "overrides": {
            "w_trend": 0.38,
            "w_momentum": 0.26,
            "w_liquidity": 0.14,
            "w_rsi": 0.12,
            "w_macd": 0.06,
            "w_value": 0.02,
            "w_size": 0.02,
            "w_quality": 0.00,
            "w_fund_flow": 0.00,
            "fast_ma": 5,
            "slow_ma": 10,
            "min_turnover_pct": 0.30,
        },
    },
    "macd_cross": {
        "label": "MACD 金叉",
        "risk": "平衡",
        "desc": "动能反转：重 MACD 动能 + 趋势，捕捉 DIF 上穿 DEA。",
        "universe_filter": "active",
        "overrides": {
            "w_macd": 0.40,
            "w_trend": 0.24,
            "w_momentum": 0.18,
            "w_rsi": 0.10,
            "w_liquidity": 0.06,
            "w_value": 0.02,
            "w_size": 0.00,
            "w_quality": 0.00,
            "w_fund_flow": 0.00,
            "macd_fast": 12,
            "macd_slow": 26,
            "macd_signal": 9,
            "min_turnover_pct": 0.30,
        },
    },
    # 游资(涨停敢死队)风格：超短强动量 + 高换手量能驱动 + 不恐高(放开估值) + 趋势确认。
    # 注：真实打板/连板需当日涨停、封单等盘口数据（引擎暂无该因子），
    # 此处用「超短周期动量 + 高换手门槛 + 量价齐升」近似游资超短打法。
    # 不依赖 mcap 市值约束——westock 行情快照无 mcap 字段，mcap_min>0 会把全部票过滤成 0 只。
    "youzi": {
        "label": "游资风格",
        "risk": "激进",
        "desc": "游资超短打法近似：超短周期强动量(8日) + 高换手量能驱动 + 不恐高(放开估值) + 短周期突破确认。捕捉游资控盘、放量拉升的弹性标的（注：真实打板需涨停盘口数据，此处用高换手+强动量近似）。",
        "universe_filter": "active",     # 候选池：高换手活跃（不能用低估值池）
        "overrides": {
            "w_momentum": 0.40,
            "w_liquidity": 0.24,      # 游资本质是资金/量能驱动，权重最高之一
            "w_trend": 0.14,
            "w_rsi": 0.06,
            "w_macd": 0.08,
            "w_value": 0.00,          # 游资炒情绪不炒价值，估值权重归零
            "w_size": 0.00,
            "w_quality": 0.00,
            "w_fund_flow": 0.08,      # 主力资金净流入是游资/题材核心驱动力
            "momentum_window": 8,     # 超短周期（游资做超短，今天进明天出）
            "max_pe_ttm": 10000,      # 不恐高，放开估值上限
            "max_pb": 1000,
            "min_turnover_pct": 1.8,  # 高换手门槛（游资进出频繁，日均换手显著高于机构票）
            "top_n": 5,
            "st_filter": "exclude_st",
            "use_breakout_filter": True,
            "breakout_window": 12,    # 短周期突破，捕捉启动
        },
    },
    # —— 激进策略（与前端 ScreenerConfigPanel.tsx 的 STRATEGY_PRESETS 同步）——
    "momentum_chase": {
        "label": "强势追涨",
        "risk": "激进",
        "desc": "激进：极高动量权重，放开 PE/PB 限制，高换手门槛，精选 4 只。追涨不恐高。",
        "universe_filter": "active",
        "overrides": {
            "w_momentum": 0.48, "w_liquidity": 0.20, "w_trend": 0.12, "w_rsi": 0.06,
            "w_macd": 0.06, "w_value": 0.00, "w_size": 0.00, "w_quality": 0.00,
            "w_fund_flow": 0.08,
            "momentum_window": 10, "max_pe_ttm": 10000, "max_pb": 1000,
            "min_turnover_pct": 2.0, "top_n": 4,
            "use_breakout_filter": True, "breakout_window": 10,
        },
    },
    "bottom_reversal": {
        "label": "超跌反弹",
        "risk": "激进",
        "desc": "激进：重 RSI 低位 + MACD 反转，筛超跌后动能回暖标的，PE/PB 放宽，精选 5 只。",
        "universe_filter": "active",     # 候选池：活跃（超跌反弹需弹性，低估值池里没有超跌题材）
        "overrides": {
            "w_rsi": 0.36, "w_macd": 0.26, "w_momentum": 0.14, "w_liquidity": 0.08,
            "w_trend": 0.06, "w_value": 0.04, "w_size": 0.00, "w_quality": 0.00,
            "w_fund_flow": 0.06,
            "momentum_window": 10, "max_pe_ttm": 500, "max_pb": 50,
            "min_turnover_pct": 0.50, "top_n": 5,
            "use_breakout_filter": False,
            "rsi_direction": "reversal",  # ⚠️ 超跌类必须反转：偏好 RSI 30~50 低位，修复追高 bug
        },
    },
    # —— 2026-08-06 新增：5 套 K 线硬过滤策略（均线/量价/涨停/倍量） ——
    "ma_momentum": {
        "label": "均线多头排列",
        "risk": "平衡",
        "desc": "MA5>MA10>MA20>MA60 完美多头排列 + MACD 金叉红柱放大 + 价站 MA20。用于主升浪中段持仓与加仓判定。",
        "universe_filter": "active",
        "overrides": {
            "w_trend": 0.35, "w_macd": 0.26, "w_momentum": 0.18,
            "w_liquidity": 0.08, "w_rsi": 0.06, "w_value": 0.04,
            "w_size": 0.00, "w_quality": 0.00, "w_fund_flow": 0.03,
            "strategy_filter": "ma_momentum",
            "min_turnover_pct": 0.50, "top_n": 6,
            "use_breakout_filter": False,
            "stop_loss_pct": -0.08,
        },
    },
    "oversold": {
        "label": "超跌反弹（严格）",
        "risk": "激进",
        "desc": "RSI(14)<30 + 触及布林下轨 + 底背离信号。快进快出，设严格止损 ≤ -5%。",
        "universe_filter": "active",
        "overrides": {
            "w_rsi": 0.42, "w_macd": 0.26, "w_momentum": 0.12, "w_liquidity": 0.08,
            "w_fund_flow": 0.06, "w_trend": 0.04, "w_value": 0.02,
            "w_size": 0.00, "w_quality": 0.00,
            "strategy_filter": "oversold",
            "rsi_direction": "reversal",      # 超跌类必须反转
            "momentum_window": 10, "max_pe_ttm": 500, "max_pb": 50,
            "min_turnover_pct": 0.30, "top_n": 5,
            "use_breakout_filter": False,
            "stop_loss_pct": -0.05,           # 严格止损 ≤ 5%
        },
    },
    "dszn": {
        "label": "DSZN 量价模型",
        "risk": "平衡",
        "desc": "八阶段量价：主攻 C/D/E 阶段（缩量回踩/横盘/放量突破），MA20 向上，量能形态判别。",
        "universe_filter": "active",
        "overrides": {
            "w_liquidity": 0.34, "w_trend": 0.26, "w_momentum": 0.18,
            "w_macd": 0.12, "w_rsi": 0.06, "w_fund_flow": 0.04,
            "w_value": 0.00, "w_size": 0.00, "w_quality": 0.00,
            "strategy_filter": "dszn",
            "min_turnover_pct": 0.50, "top_n": 6,
            "max_pe_ttm": 10000, "max_pb": 1000,
            "use_breakout_filter": False,
        },
    },
    "limit_up": {
        "label": "涨停中继",
        "risk": "激进",
        "desc": "涨停板后 2~5 日缩量整理不破涨停底 + 均线完全多头(5>10>20>60>250)，博二波主升。",
        "universe_filter": "active",
        "overrides": {
            "w_momentum": 0.35, "w_liquidity": 0.25, "w_trend": 0.20,
            "w_macd": 0.10, "w_rsi": 0.06, "w_fund_flow": 0.04,
            "w_value": 0.00, "w_size": 0.00, "w_quality": 0.00,
            "strategy_filter": "limit_up",
            "min_turnover_pct": 1.5, "top_n": 5,
            "max_pe_ttm": 10000, "max_pb": 1000,
            "use_breakout_filter": False,
        },
    },
    "volume_breakout": {
        "label": "倍量突破",
        "risk": "平衡",
        "desc": "成交量 ≥ 2× 近 20 日均量 + 突破 20 日最高价 + 换手 ≥ 3% + MACD 金叉确认。",
        "universe_filter": "active",
        "overrides": {
            "w_momentum": 0.38, "w_liquidity": 0.28, "w_trend": 0.14,
            "w_rsi": 0.08, "w_macd": 0.08, "w_value": 0.02,
            "w_size": 0.00, "w_quality": 0.00, "w_fund_flow": 0.02,
            "strategy_filter": "volume_breakout",
            "min_turnover_pct": 3.0, "top_n": 5,
            "use_breakout_filter": True, "breakout_window": 20,
            "momentum_window": 20,
        },
    },
    # —— 2026-08-08 新增：142857 江恩回调支撑策略 ——
    # 142857 是 1/7 的循环小数，其各位 14.28%/28.57%/42.85% 被江恩理论用作价格
    # 波动的关键回调支撑比例。本策略取近 60 日上涨波段高低点，按前三档计算支撑位，
    # 捕捉「上升趋势中回踩档位企稳」的低吸买点（缩量企稳 + 均线多头确认）。
    "gann_142857": {
        "label": "江恩142857回调",
        "risk": "平衡",
        "desc": "基于142857（1/7循环）关键比例：上涨波段回踩14.28%/28.57%/42.85%档位企稳 + 缩量 + 均线多头，捕捉趋势中继低吸买点。",
        "universe_filter": "active",
        "overrides": {
            "w_trend": 0.34, "w_momentum": 0.22, "w_liquidity": 0.16,
            "w_rsi": 0.10, "w_macd": 0.10, "w_value": 0.04,
            "w_size": 0.00, "w_quality": 0.00, "w_fund_flow": 0.04,
            "strategy_filter": "gann_142857",
            "min_turnover_pct": 0.50, "top_n": 6,
            "use_breakout_filter": False,
            "stop_loss_pct": -0.08,
        },
    },
}


def get_preset(name: str) -> dict | None:
    """返回预设定义（含 label/desc/overrides）；不存在返回 None。"""
    return STRATEGY_PRESETS.get(name)


def resolve_preset(overrides: dict) -> dict:
    """若 overrides 含 'preset'，把对应预设的覆盖值合并为基线。

    优先级：显式覆盖字段 > 预设基线。预设键本身保留在返回 dict 中，
    便于调用方感知当前生效的预设。不修改入参，返回新 dict。
    """
    preset_name = overrides.get("preset")
    if not preset_name:
        return dict(overrides)
    preset = STRATEGY_PRESETS.get(preset_name)
    if not preset:
        return dict(overrides)
    merged: dict = dict(preset.get("overrides", {}))
    for k, v in overrides.items():
        if k == "preset":
            continue
        merged[k] = v
    merged["preset"] = preset_name
    return merged
