"""操作模式角色卡：区分超短/短线/波段/长线，避免 AI 用错时间框架。

背景（2026-08-06）：某 AI 分析把「历史泡沫顶 66.39」当目标位，算出
「距阻力位还有 110.8% 空间」，只因没有定义决策者是谁。同一只票，
超短看 J 值/量价，长线看基本面/估值，结论可以完全相反。

本模块为 run_hub 提供 --mode 参数的角色卡：
  - 超短 ultra_short：只回答 1-3 天能否参与，给出买卖价位与止损剧本
  - 短线 short      ：3-10 天，等趋势信号确认
  - 波段 swing      ：1-3 月，中期趋势 + 估值
  - 长线 long       ：6 月+，只看基本面与估值安全边际

用法：
  PY run_hub.py --prefetched prefetched.json --mode ultra_short ...
  不传 --mode 时依次回退：CLI > prefetched 内嵌 config.mode > 环境变量
  TRADE_MODE > 默认 short。报告/推送会附带本模式角色卡，后续 AI
  据此按模式裁剪输出（超短不输出历史目标位空间，长线不输出 KDJ 噪音）。
"""
from __future__ import annotations

import os

MODE_CHOICES: tuple[str, ...] = ("ultra_short", "short", "swing", "long")
DEFAULT_MODE = "short"

MODE_LABELS: dict[str, str] = {
    "ultra_short": "超短",
    "short": "短线",
    "swing": "波段",
    "long": "长线",
}

# 模式别名（中文/简写 → 标准 key）
_ALIASES: dict[str, str] = {
    "ultrashort": "ultra_short",
    "超短": "ultra_short",
    "短线": "short",
    "波段": "swing",
    "长线": "long",
}

# 模式角色卡：每项都是给 AI 的硬约束（决策者是谁、看什么、忽略什么）
MODE_PROFILES: dict[str, dict] = {
    "ultra_short": {
        "label": "超短",
        "holding": "1-3 天",
        "frame": "60分钟 - 日线",
        "buy": "量价配合、分时强度、题材情绪、突破/回踩结构",
        "sell_stop": "止损 -3%~-5% 硬止损；止盈按目标位/破位",
        "position": "≤10-15% 试错仓（高波动个股更小）",
        "emphasize": ["动量", "RSI", "换手", "KDJ J 值", "量比", "支撑/压力", "止损剧本"],
        "ignore": ["历史目标位空间", "半年以上估值锚", "长期基本面叙事"],
        "note": "只回答 1-3 天能否参与：给出明确买卖价位与止损，不做中长期目标价预测",
    },
    "short": {
        "label": "短线",
        "holding": "3-10 天",
        "frame": "日线",
        "buy": "均线形态（MA5/10/20）、板块轮动、放量突破站稳",
        "sell_stop": "止损 -7% 或跌破关键均线；止盈按压力位分批",
        "position": "≤20-30%",
        "emphasize": ["趋势（均线排列）", "量能持续性", "板块热度", "MACD", "关键压力位"],
        "ignore": ["分钟级噪音", "超远期目标位"],
        "note": "回答 3-10 天波段：等趋势信号确认（如站稳 MA20 放量），不做日内择时",
    },
    "swing": {
        "label": "波段",
        "holding": "1-3 个月",
        "frame": "日线 + 周线",
        "buy": "中期趋势、估值修复、行业景气、回调到关键支撑",
        "sell_stop": "止损 -10% 或逻辑破坏；止盈按趋势目标/估值上沿",
        "position": "≤30-50%",
        "emphasize": ["周线趋势", "行业景气", "估值分位", "筹码结构", "业绩预期"],
        "ignore": ["日线 J 值超买超卖", "单日量比波动"],
        "note": "回答 1-3 月波段：以中期趋势与估值为主，忽略日内噪音",
    },
    "long": {
        "label": "长线",
        "holding": "6 个月以上",
        "frame": "周线 + 月线 + 基本面",
        "buy": "基本面、估值安全边际、行业周期、现金流与分红",
        "sell_stop": "基本面恶化/逻辑证伪时退出，不设价格止损",
        "position": "按组合配置，单票 ≤10-20%",
        "emphasize": ["PE/PB 估值", "ROE/股息率", "行业空间", "财务质量"],
        "ignore": ["KDJ/RSI 短线指标", "单日量价", "技术形态噪音"],
        "note": "只回答长期持有价值：以估值与基本面为准绳，短期波动不构成买卖依据",
    },
}


def resolve_mode(value: str | None = None) -> str:
    """解析操作模式。优先级：显式传入 > prefetched config > TRADE_MODE env > 默认 short。

    返回标准 key（ultra_short / short / swing / long）。非法值打印提示并回退默认。
    """
    v = value
    if not v or not str(v).strip():
        v = os.environ.get("TRADE_MODE") or DEFAULT_MODE
    v = str(v).strip().lower()
    if v in MODE_LABELS:
        return v
    v = _ALIASES.get(v, v)
    if v in MODE_LABELS:
        return v
    print(f"[trade_mode] 未知模式 {value!r}，回退默认 {DEFAULT_MODE}（可选：{', '.join(MODE_CHOICES)}）")
    return DEFAULT_MODE


def render_mode_card(mode: str) -> str:
    """生成角色卡 Markdown 文本（注入报告/推送，供 AI 与读者了解操作模式约束）。"""
    p = MODE_PROFILES.get(mode) or MODE_PROFILES[DEFAULT_MODE]
    return "\n".join(
        [
            f"**操作模式**：{p['label']}（持仓 {p['holding']}｜决策框架：{p['frame']}）",
            f"- 买入依据：{p['buy']}",
            f"- 止损/止盈：{p['sell_stop']}",
            f"- 仓位上限：{p['position']}",
            f"- 应忽略（噪音）：{'、'.join(p['ignore'])}",
            f"- 报告要求：{p['note']}",
        ]
    )


def render_mode_summary_line(mode: str) -> str:
    """一行紧凑摘要（推送正文开头用）。"""
    p = MODE_PROFILES.get(mode) or MODE_PROFILES[DEFAULT_MODE]
    return (
        f"**操作模式**：{p['label']}（{p['holding']}｜{p['frame']}）"
        f"· 买入：{p['buy']} · 忽略噪音：{'、'.join(p['ignore'])}"
    )
