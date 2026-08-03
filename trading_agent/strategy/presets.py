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
STRATEGY_PRESETS: dict[str, dict] = {
    # —— 保守策略（低风险：重估值/质量/规模，低波动，避开追涨）——
    "value_defensive": {
        "label": "价值防御",
        "risk": "保守",
        "desc": "保守：重估值 + 质量 + 大市值，低动量/低换手，宽止损，避开高波动与题材炒作。适合稳健底仓。",
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
        "risk": "balanced",
        "desc": "强调动量 + 量能，要求活跃换手，捕捉横盘后放量突破前高。",
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
        "overrides": {
            "w_rsi": 0.36, "w_macd": 0.26, "w_momentum": 0.14, "w_liquidity": 0.08,
            "w_trend": 0.06, "w_value": 0.04, "w_size": 0.00, "w_quality": 0.00,
            "w_fund_flow": 0.06,
            "momentum_window": 10, "max_pe_ttm": 500, "max_pb": 50,
            "min_turnover_pct": 0.50, "top_n": 5,
            "use_breakout_filter": False,
        },
    },
    "hot_theme": {
        "label": "题材热点追踪",
        "risk": "激进",
        "desc": "激进：流动性为王 + 量能，不限 PE/PB，极高换手门槛，每板块只取 1 只，纯交易驱动。",
        "overrides": {
            "w_liquidity": 0.36, "w_momentum": 0.22, "w_macd": 0.14, "w_trend": 0.10,
            "w_rsi": 0.04, "w_value": 0.02, "w_size": 0.00, "w_quality": 0.00,
            "w_fund_flow": 0.12,      # 题材热点最核心驱动就是主力资金净流入
            "macd_fast": 6, "macd_slow": 13, "macd_signal": 5,
            "max_pe_ttm": 10000, "max_pb": 1000,
            "min_turnover_pct": 3.0, "top_n": 3, "max_per_sector": 1,
            "use_breakout_filter": False,
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
