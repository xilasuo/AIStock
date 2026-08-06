"""开仓闸门：统一判定「当前是否可以开新仓」。

把分散的风控前置逻辑收敛成一个透明、可解释的 verdict，供选股闭环、报告、
前端卡片与 AI 决策语共同消费。判定来源（按优先级叠加）：

1. 市场牛熊（来自 market_state.detect_regime 的 position_factor）：
     bear   → 禁止开仓（position_factor==0）
     neutral→ 限制开仓（小仓试探，仓位系数 <1）
     bull   → 开放开仓（仓位系数 1）
     unknown→ 谨慎（按中性处理，不强行空仓）

2. 可配置风控阈值（config.OpenGateConfig）：
     block_on_bear      : 熊市是否禁止开仓（默认 True）
     max_daily_loss_pct : 日内亏损达此比例 → 熔断禁止（需注入 risk_state；<=0 关闭）
     max_drawdown_pct   : 回撤达此比例 → 暂停开仓（需注入 risk_state；<=0 关闭）
     quiet_hours        : 上海时间落在这些区间内 → 不开新仓（如午休、收盘前）

3. 持仓容量（可选，注入 current_positions 时生效）：
     current_positions >= max_positions → 禁止（已无开仓额度）

risk_state（可选，由中枢/tdx 注入实时账户）：{"daily_pnl_pct": float, "drawdown_pct": float}
current_positions（可选）：当前持仓只数。两者皆缺省时对应检查跳过（仅做环境判定）。

输出 verdict 字典：
  {
    "can_open": bool,
    "level": "open" | "partial" | "blocked",
    "reasons": [str, ...],            # 人类可读，逐条解释
    "effective_factor": float,        # 建议生效的仓位系数（blocked→0）
    "market_state": str,
    "position_factor": float,
    "max_positions": int,
    "current_positions": int | None,
    "config": {...},                  # 回显生效阈值（便于溯源）
  }
"""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class OpenGateConfig:
    """开仓闸门配置（风控前置的可调参数）。"""
    enabled: bool = True
    block_on_bear: bool = True
    # 日内亏损熔断比例（百分比，如 3.0=亏损 3% 即熔断）。<=0 表示关闭。
    max_daily_loss_pct: float = 3.0
    # 最大回撤暂停比例（百分比）。<=0 表示关闭。
    max_drawdown_pct: float = 15.0
    # 闲时不开仓窗口（上海时间，逗号分隔的 HH:MM-HH:MM；空串=不限制）。
    # 例："11:30-13:00,14:55-15:00"（午休 + 收盘前 5 分钟不新开仓）。
    quiet_hours: str = "11:30-13:00,14:55-15:00"


def _parse_quiet_hours(spec: str) -> list[tuple[int, int]]:
    """把 "11:30-13:00,14:55-15:00" 解析成 [(start_min, end_min), ...]。"""
    out: list[tuple[int, int]] = []
    if not spec:
        return out
    for part in spec.split(","):
        part = part.strip()
        if not part or "-" not in part:
            continue
        a, b = part.split("-", 1)
        try:
            h1, m1 = (int(x) for x in a.strip().split(":"))
            h2, m2 = (int(x) for x in b.strip().split(":"))
        except ValueError:
            continue
        out.append((h1 * 60 + m1, h2 * 60 + m2))
    return out


def _now_shanghai_minutes() -> int:
    """当前上海时间（HH*60+MM）。避免引入额外依赖，复用 timeutil。"""
    from timeutil import sh_now
    t = sh_now()
    return t.hour * 60 + t.minute


def _in_quiet_window(spec: str) -> bool:
    now = _now_shanghai_minutes()
    for start, end in _parse_quiet_hours(spec):
        if start <= now <= end:
            return True
    return False


def evaluate_gate(
    cfg: OpenGateConfig,
    regime: dict,
    *,
    max_positions: int = 0,
    risk_state: dict | None = None,
    current_positions: int | None = None,
) -> dict:
    """计算开仓闸门 verdict。

    参数
    ----
    cfg            : OpenGateConfig
    regime         : market_state.detect_regime 的返回（含 state / position_factor / detail）
    max_positions  : SignalConfig.max_positions（用于容量展示与校验）
    risk_state     : 可选，{"daily_pnl_pct": float, "drawdown_pct": float}
    current_positions: 可选，当前持仓只数
    """
    if not cfg.enabled:
        return {
            "can_open": True,
            "level": "open",
            "reasons": ["开仓闸门已关闭（config.enabled=False），不拦截"],
            "effective_factor": float(regime.get("position_factor", 1.0)),
            "market_state": regime.get("state", "unknown"),
            "position_factor": float(regime.get("position_factor", 1.0)),
            "max_positions": int(max_positions),
            "current_positions": current_positions,
            "config": _config_view(cfg),
        }

    state = regime.get("state", "unknown")
    position_factor = float(regime.get("position_factor", 1.0))

    # —— 1) 市场牛熊基线 ——
    if state == "bear":
        level = "blocked"
        factor = 0.0
        reasons = ["熊市：仓位系数 0，禁止开新仓"]
    elif state == "bull":
        level = "open"
        factor = position_factor
        reasons = [f"牛市：可正常开仓，仓位系数 {position_factor:.2f}"]
    elif state == "neutral":
        level = "partial"
        factor = position_factor
        reasons = [f"中性：可小仓试探，仓位系数 {position_factor:.2f}"]
    else:  # unknown
        level = "partial"
        factor = position_factor
        reasons = ["市场状态未知：按中性谨慎处理，小仓试探"]

    blocked = level == "blocked"

    # —— 2) 持仓容量校验 ——
    if not blocked and current_positions is not None and max_positions and current_positions >= max_positions:
        blocked = True
        level = "blocked"
        factor = 0.0
        reasons.append(f"已达最大持仓 {current_positions}/{max_positions}，无开仓额度")

    # —— 3) 风控熔断（需注入 risk_state）——
    rs = risk_state or {}
    daily = rs.get("daily_pnl_pct")
    dd = rs.get("drawdown_pct")
    if cfg.max_daily_loss_pct > 0 and daily is not None and daily <= -cfg.max_daily_loss_pct:
        blocked = True
        level = "blocked"
        factor = 0.0
        reasons.append(f"日内亏损 {daily:.2f}% 触及熔断线 {cfg.max_daily_loss_pct:.2f}%，暂停开仓")
    if cfg.max_drawdown_pct > 0 and dd is not None and dd >= cfg.max_drawdown_pct:
        blocked = True
        level = "blocked"
        factor = 0.0
        reasons.append(f"回撤 {dd:.2f}% 达上限 {cfg.max_drawdown_pct:.2f}%，暂停开仓")

    # —— 4) 闲时不开仓 ——
    if not blocked and cfg.quiet_hours and _in_quiet_window(cfg.quiet_hours):
        blocked = True
        level = "blocked"
        factor = 0.0
        reasons.append(f"当前为闲时（{cfg.quiet_hours}），不开新仓")

    # 兜底：若被任一规则判为 blocked，can_open 必须为 False、factor=0
    if blocked:
        level = "blocked"
        factor = 0.0
        reasons = reasons or ["开仓被拦截"]

    return {
        "can_open": not blocked,
        "level": level,
        "reasons": reasons,
        "effective_factor": float(factor),
        "market_state": state,
        "position_factor": position_factor,
        "max_positions": int(max_positions),
        "current_positions": current_positions,
        "config": _config_view(cfg),
    }


def _config_view(cfg: OpenGateConfig) -> dict:
    return {
        "enabled": cfg.enabled,
        "block_on_bear": cfg.block_on_bear,
        "max_daily_loss_pct": cfg.max_daily_loss_pct,
        "max_drawdown_pct": cfg.max_drawdown_pct,
        "quiet_hours": cfg.quiet_hours,
    }
