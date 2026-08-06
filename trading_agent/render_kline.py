"""K线面板渲染 · 数据→技术标注→深色 SVG 全链路

用法:
    python render_kline.py 600367                 # 默认最近 110 根日K，输出 reports/kline_panel_*.svg
    python render_kline.py 600367 --days 250      # 显示更多K线
    python render_kline.py 600367 --out temp      # 自定义输出目录

Python API:
    from render_kline import render_kline_panel
    path, markers, svg = render_kline_panel("600367")

与截图同款视觉: 深色网格底 + 红涨绿跌蜡烛 + 五条关键价位线
(泡沫顶 / 突破确认位 / 现价 / 回踩点 / 双底生死线) + 底部红绿成交量。
数据源复用 data/provider.py（东财前复权日K + 腾讯估值），免 key、本地缓存。
"""
from __future__ import annotations

import os
import sys
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from data.provider import fetch_kline, fetch_quote  # noqa: E402
from timeutil import sh_now  # noqa: E402

# ---------------------------------------------------------------- 配色
C_BG = "#0a0e14"
C_GRID = "#1f2937"
C_UP = "#ef4444"      # 涨 = 红（A股惯例）
C_DOWN = "#22c55e"    # 跌 = 绿
C_TEXT = "#e2e8f0"
C_SUB = "#94a3b8"
C_DIM = "#64748b"
C_BLUE = "#3b82f6"    # 现价
C_ORANGE = "#f59e0b"  # 生死线
C_GRAY = "#9ca3af"    # 突破/回踩
C_MA5 = "#e2e8f0"     # 白
C_MA10 = "#facc15"    # 黄
C_MA20 = "#c084fc"    # 紫
C_MA60 = "#4ade80"    # 绿（A股软件惯例）

FONT = "ui-monospace, Menlo, Consolas, monospace"


def _mean(xs):
    return sum(xs) / len(xs) if xs else 0.0


def _ma(closes: list[float], period: int) -> list[float | None]:
    """滚动均线：返回每根K线对应的 MA 值，窗口未满时为 None。"""
    out: list[float | None] = [None] * len(closes)
    s = 0.0
    for i, c in enumerate(closes):
        s += c
        if i >= period:
            s -= closes[i - period]
        if i >= period - 1:
            out[i] = s / period
    return out


def _ma_polyline(cx: list[float], ma: list[float | None], Y) -> str:
    """返回均线 polyline 的 points 字符串（无有效点返回空串）。"""
    pts = [f"{cx[i]:.1f},{Y(v):.1f}" for i, v in enumerate(ma) if v is not None]
    return " ".join(pts)


def _recent_resistance(highs: list[float], price: float, n: int, look: int = 8) -> float | None:
    """从右往左找第一个比现价高 3%+ 的反弹高点（其后 look 根内未再创新高）。

    语义：现价上方最近的套牢/压力位，即「突破确认位」。
    """
    for i in range(n - 1, -1, -1):
        h = highs[i]
        if h < price * 1.03:
            continue
        if max(highs[i + 1:i + 1 + look]) < h:
            return h
    return None


# ---------------------------------------------------------------- 标注识别
def detect_markers(bars: list[dict], name: str = "") -> dict:
    """从日K序列识别截图同款五条关键价位。

    返回 dict:
      price_now  现价
      ma5/ma10/ma20/ma60/ma120 均线
      top        {price, date, is_trap} 泡沫顶（近120根最高，久未创新高=套牢盘）
      breakout   突破确认位（双底颈线，或近60日平台高点）
      retest     {price, date} | None 突破后首次回踩点
      support    双底（生死线）支撑
      double_bottom  {support, neck, dates} | None
    """
    n = len(bars)
    closes = [b["close"] for b in bars]
    highs = [b["high"] for b in bars]
    lows = [b["low"] for b in bars]
    dates = [b["date"] for b in bars]

    ma5 = _mean(closes[-5:]) if n >= 5 else _mean(closes)
    ma10 = _mean(closes[-10:]) if n >= 10 else _mean(closes)
    ma20 = _mean(closes[-20:]) if n >= 20 else _mean(closes)
    ma60 = _mean(closes[-60:]) if n >= 60 else _mean(closes)
    ma120 = _mean(closes[-120:]) if n >= 120 else _mean(closes)
    price_now = closes[-1]

    # --- 泡沫顶：近 120 根最高点 ---
    win = min(n, 120)
    top_win = highs[-win:]
    top_local = top_win.index(max(top_win))
    top_price = top_win[top_local]
    top_date = dates[n - win + top_local]
    is_trap = top_local <= win - 1 - 20  # 该高点距今 >= 20 根 → 上方全是套牢盘

    # --- 双底识别：局部低点配对（间隔>=20根、价差<=5%、中间反弹>=10%）---
    W = 6
    lows_idx = [
        i for i in range(W, n - W)
        if lows[i] == min(lows[i - W:i + W + 1]) and lows[i] < lows[i - 1]
    ]
    double_bottom = None
    for j in range(len(lows_idx) - 1, 0, -1):
        i_a, i_b = lows_idx[j - 1], lows_idx[j]
        if i_b - i_a < 20:
            continue
        p_a, p_b = lows[i_a], lows[i_b]
        if p_a <= 0 or abs(p_b - p_a) / p_a > 0.05:
            continue
        mid_high = max(highs[i_a:i_b + 1])
        if mid_high > max(p_a, p_b) * 1.10:
            double_bottom = {
                "support": min(p_a, p_b),
                "neck": mid_high,
                "dates": (dates[i_a], dates[i_b]),
            }
            break

    # --- 生死线：双底支撑优先，否则取近 30 根最低点（近期关键支撑）---
    if double_bottom:
        support = double_bottom["support"]
    else:
        support = min(lows[-min(n, 30):])

    # --- 突破确认位：双底颈线优先，否则取现价上方最近的反弹高点（压力位）---
    if double_bottom:
        breakout = double_bottom["neck"]
    else:
        breakout = _recent_resistance(highs, price_now, n)
        if breakout is None:
            breakout = max(closes[-min(n, 60):])  # 平台高点兜底

    # --- 回踩点 ---
    if double_bottom:
        # 严格双底：站上颈线后回落至颈线附近(±8%)的最低点
        retest = None
        above = [i for i in range(n) if closes[i] > breakout]
        if above:
            first_above = above[0]
            cands = [
                (i, lows[i]) for i in range(first_above, n)
                if breakout * 0.92 <= lows[i] <= breakout * 1.06
            ]
            if cands:
                i, l = min(cands, key=lambda t: t[1])
                if n - 1 - i >= 2:
                    retest = {"price": l, "date": dates[i]}
    else:
        # 常规：近 20 根内、现价下方、距当前 >=3 根、最接近现价的局部低点
        cands = [
            (i, lows[i]) for i in range(max(0, n - 20), n - 3)
            if lows[i] < price_now and lows[i] >= support * 0.98
        ]
        if cands:
            i, l = max(cands, key=lambda t: t[1])
            retest = {"price": l, "date": dates[i]}

    # --- 现价相对均线位置（截图："顶在 MA20/MA120"）---
    if price_now > ma20 and price_now > ma120:
        ma_pos = "站稳 MA20/MA120"
    elif price_now > ma20 or price_now > ma120:
        ma_pos = "顶在 MA20/MA120"
    else:
        ma_pos = "位于 MA20/MA120 下方"

    return {
        "name": name,
        "price_now": price_now,
        "ma5": ma5,
        "ma10": ma10,
        "ma20": ma20,
        "ma60": ma60,
        "ma120": ma120,
        "ma_pos": ma_pos,
        "top": {"price": top_price, "date": top_date, "is_trap": is_trap},
        "breakout": breakout,
        "retest": retest,
        "support": support,
        "double_bottom": double_bottom,
    }


# ---------------------------------------------------------------- SVG 渲染
def render_svg(code: str, name: str, bars: list[dict], mk: dict, max_bars: int = 110) -> str:
    """渲染深色主题 K线 SVG（viewBox 0 0 680 480）。"""
    show = bars[-max_bars:]
    n = len(show)
    dates = [b["date"] for b in show]
    opens = [b["open"] for b in show]
    closes = [b["close"] for b in show]
    highs = [b["high"] for b in show]
    lows = [b["low"] for b in show]
    vols = [b["vol"] for b in show]

    # 价格坐标
    p_min, p_max = min(lows), max(highs)
    pad = (p_max - p_min) * 0.08 or 1.0
    lo, hi = p_min - pad, p_max + pad

    def Y(p):
        return 18.0 + (hi - p) / (hi - lo) * 360.0

    # 成交量坐标
    v_max = max(vols) or 1.0

    def YV(v):
        return 446.0 - (v / v_max) * 64.0

    # 蜡烛几何
    area_x0, area_x1 = 24.0, 636.0
    area_w = area_x1 - area_x0
    slot = area_w / n
    cw = max(3.0, min(10.0, slot * 0.62))
    left = [area_x0 + i * slot + (slot - cw) / 2 for i in range(n)]
    cx = [area_x0 + i * slot + slot / 2 for i in range(n)]

    def d_short(date_str: str) -> str:
        return date_str[5:] if len(date_str) >= 10 else date_str

    # ---- 顶栏 ----
    top = (
        f'<g font-size="9" fill="{C_SUB}">'
        f'<rect x="24" y="2" width="8" height="8" fill="{C_UP}"/>'
        f'<text x="36" y="9">涨</text>'
        f'<rect x="52" y="2" width="8" height="8" fill="{C_DOWN}"/>'
        f'<text x="64" y="9">跌</text>'
        f'<text x="84" y="9" fill="{C_TEXT}">{name} {code} · 日K {d_short(dates[0])}~{d_short(dates[-1])}</text>'
        f'<text x="360" y="9" fill="{C_ORANGE}">{mk["support"]:.2f} 双底（生死线）</text>'
        f'<text x="636" y="9" text-anchor="end" fill="{C_DIM}">截至 {d_short(dates[-1])} 收盘</text>'
        f'</g>'
    )

    # ---- 网格 + 价格刻度 ----
    grid = []
    scale = []
    for k in range(5):
        v = hi - k * (hi - lo) / 4
        y = Y(v)
        grid.append(f'<line x1="{area_x0}" y1="{y:.1f}" x2="{area_x1}" y2="{y:.1f}" stroke="{C_GRID}" stroke-dasharray="2,3" stroke-width="0.5"/>')
        scale.append(f'<text x="20" y="{y + 3:.1f}" text-anchor="end" font-size="9" fill="{C_DIM}">{v:.2f}</text>')

    # ---- 水平关键位 ----
    lines = []
    tags = []
    t = mk["top"]
    lines.append(f'<line x1="{area_x0}" y1="{Y(t["price"]):.1f}" x2="{area_x1}" y2="{Y(t["price"]):.1f}" stroke="{C_UP}" stroke-width="0.6" stroke-dasharray="6,4" opacity="0.55"/>')
    tags.append(f'<text x="632" y="{Y(t["price"]) - 4:.1f}" text-anchor="end" font-size="9" fill="{C_TEXT}">{t["price"]:.2f} 泡沫顶 · {d_short(t["date"])}{"（上方套牢盘）" if t["is_trap"] else ""}</text>')

    lines.append(f'<line x1="{area_x0}" y1="{Y(mk["breakout"]):.1f}" x2="{area_x1}" y2="{Y(mk["breakout"]):.1f}" stroke="{C_GRAY}" stroke-width="0.5" stroke-dasharray="3,3" opacity="0.55"/>')
    tags.append(f'<text x="632" y="{Y(mk["breakout"]) - 4:.1f}" text-anchor="end" font-size="9" fill="{C_SUB}">{mk["breakout"]:.2f} 突破确认位</text>')

    lines.append(f'<line x1="{area_x0}" y1="{Y(mk["price_now"]):.1f}" x2="{area_x1}" y2="{Y(mk["price_now"]):.1f}" stroke="{C_BLUE}" stroke-width="1.2"/>')
    tags.append(f'<text x="632" y="{Y(mk["price_now"]) + 12:.1f}" text-anchor="end" font-size="9" fill="{C_BLUE}" font-weight="500">{mk["price_now"]:.2f} 现价（{mk["ma_pos"]}）</text>')

    if mk["retest"]:
        rp = mk["retest"]["price"]
        lines.append(f'<line x1="{area_x0}" y1="{Y(rp):.1f}" x2="{area_x1}" y2="{Y(rp):.1f}" stroke="{C_GRAY}" stroke-width="0.5" stroke-dasharray="3,3" opacity="0.55"/>')
        tags.append(f'<text x="632" y="{Y(rp) - 4:.1f}" text-anchor="end" font-size="9" fill="{C_SUB}">{rp:.2f} 回踩点</text>')

    sp = mk["support"]
    lines.append(f'<line x1="{area_x0}" y1="{Y(sp):.1f}" x2="{area_x1}" y2="{Y(sp):.1f}" stroke="{C_ORANGE}" stroke-width="0.9" stroke-dasharray="4,3"/>')
    tags.append(f'<text x="632" y="{Y(sp) + 12:.1f}" text-anchor="end" font-size="9" fill="{C_ORANGE}" font-weight="500">{sp:.2f} 双底（生死线）</text>')

    # ---- 蜡烛 ----
    candles = []
    for i in range(n):
        o, c, h, l = opens[i], closes[i], highs[i], lows[i]
        color = C_UP if c >= o else C_DOWN
        y_hi, y_lo = Y(h), Y(l)
        y_top = Y(max(o, c))
        hgt = max(1.0, abs(Y(o) - Y(c)))
        candles.append(
            f'<line x1="{cx[i]:.1f}" y1="{y_hi:.1f}" x2="{cx[i]:.1f}" y2="{y_lo:.1f}" stroke="{color}"/>'
            f'<rect x="{left[i]:.1f}" y="{y_top:.1f}" width="{cw:.1f}" height="{hgt:.1f}" fill="{color}"/>'
        )

    # ---- 成交量 ----
    vbars = []
    for i in range(n):
        color = C_UP if closes[i] >= opens[i] else C_DOWN
        vbars.append(
            f'<rect x="{left[i]:.1f}" y="{YV(vols[i]):.1f}" width="{cw:.1f}" height="{446.0 - YV(vols[i]):.1f}" fill="{color}" opacity="0.85"/>'
        )

    # ---- 时间轴 ----
    tlabels = []
    for idx in (0, n // 3, 2 * n // 3, n - 1):
        tlabels.append(f'<text x="{cx[idx]:.1f}" y="462" text-anchor="middle" font-size="9" fill="{C_DIM}">{d_short(dates[idx])}</text>')

    # ---- MA5/10/20/60 均线曲线（画在蜡烛之上） ----
    mas = [
        (5, C_MA5, "MA5"),
        (10, C_MA10, "MA10"),
        (20, C_MA20, "MA20"),
        (60, C_MA60, "MA60"),
    ]
    ma_lines = []
    legend_parts = []
    for idx, (period, color, label) in enumerate(mas):
        arr = _ma(closes, period)
        points = _ma_polyline(cx, arr, Y)
        if points:
            ma_lines.append(
                f'<polyline points="{points}" fill="none" stroke="{color}" stroke-width="1.1" opacity="0.9"/>'
            )
        col = idx % 2
        row = idx // 2
        last = arr[-1]
        txt = "--" if last is None else f"{last:.2f}"
        lx = 34 + col * 70
        ly = 27 + row * 12
        legend_parts.append(
            f'<rect x="{lx}" y="{ly}" width="7" height="7" fill="{color}"/>'
            f'<text x="{lx + 10}" y="{ly + 7}" fill="{color}">{label} {txt}</text>'
        )
    ma_legend = (
        '<g font-size="8.5">'
        '<rect x="28" y="22" width="178" height="26" rx="3" fill="rgba(10,14,20,0.62)" '
        f'stroke="{C_GRID}" stroke-width="0.5"/>'
        + "".join(legend_parts)
        + "</g>"
    )

    return f'''<svg viewBox="0 0 680 480" xmlns="http://www.w3.org/2000/svg" role="img" font-family="{FONT}">
<title>{name} {code} 日K 技术面板</title>
<desc>{name} {code} 日K线，MA5/10/20/60 均线，标注泡沫顶、突破确认位、现价、回踩点、双底（生死线）。</desc>
<defs>
  <pattern id="g" width="20" height="20" patternUnits="userSpaceOnUse">
    <path d="M 20 0 L 0 0 0 20" fill="none" stroke="{C_GRID}" stroke-width="0.5"/>
  </pattern>
  <pattern id="g2" width="20" height="14" patternUnits="userSpaceOnUse">
    <path d="M 20 0 L 0 0 0 14" fill="none" stroke="{C_GRID}" stroke-width="0.5"/>
  </pattern>
</defs>
{top}
<rect x="{area_x0}" y="18" width="{area_w:.0f}" height="360" fill="{C_BG}"/>
<rect x="{area_x0}" y="18" width="{area_w:.0f}" height="360" fill="url(#g)"/>
{"".join(grid)}
{"".join(scale)}
{"".join(lines)}
<g stroke-width="1">{"".join(candles)}</g>
{"".join(ma_lines)}
{ma_legend}
{"".join(tags)}
<line x1="{area_x0}" y1="380" x2="{area_x1}" y2="380" stroke="{C_GRID}" stroke-width="0.5"/>
<rect x="{area_x0}" y="382" width="{area_w:.0f}" height="64" fill="{C_BG}"/>
<rect x="{area_x0}" y="382" width="{area_w:.0f}" height="64" fill="url(#g2)"/>
{"".join(vbars)}
<text x="24" y="472" font-size="9" fill="{C_DIM}">成交量</text>
{"".join(tlabels)}
</svg>'''


# ---------------------------------------------------------------- 主入口
def render_kline_panel(code: str, days: int = 110, out_dir: str | None = None, beg: str | None = None, save: bool = True) -> tuple[str, dict, str]:
    """生成 K线技术面板。

    参数:
      days   显示最近 N 根K线（默认 110）
      out_dir 输出目录（None 且 save=True 时用默认 reports/）
      save    是否写 SVG 文件（云端嵌入场景可传 False，只返回文本）

    返回: (svg_path, markers, svg_text)；save=False 时 svg_path 为空串。
    """
    if beg is None:
        beg = (sh_now().date() - timedelta(days=620)).strftime("%Y%m%d")
    bars = fetch_kline(code, beg=beg)
    if not bars:
        raise RuntimeError(f"未取到 {code} 的日K数据（东财/新浪均失败）")

    quote = {}
    try:
        quote = fetch_quote(code) or {}
    except Exception:
        pass
    name = quote.get("name") or code

    mk = detect_markers(bars, name=name)
    svg = render_svg(code, name, bars, mk, max_bars=days)

    if not save:
        return "", mk, svg

    if out_dir is None:
        out_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "reports")
    os.makedirs(out_dir, exist_ok=True)
    stamp = sh_now().strftime("%Y%m%d")
    path = os.path.join(out_dir, f"kline_panel_{code}_{stamp}.svg")
    with open(path, "w", encoding="utf-8") as f:
        f.write(svg)
    return path, mk, svg


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser(description="K线技术面板渲染（数据→标注→SVG）")
    ap.add_argument("code", help="股票代码，如 600367 / 000001")
    ap.add_argument("--days", type=int, default=110, help="显示最近 N 根K线（默认 110）")
    ap.add_argument("--out", default=None, help="输出目录（默认 trading_agent/reports）")
    args = ap.parse_args()

    path, mk, _ = render_kline_panel(args.code, days=args.days, out_dir=args.out)
    print(f"SVG 已生成: {path}")
    print(f"现价 {mk['price_now']:.2f} | MA5 {mk['ma5']:.2f} / MA10 {mk['ma10']:.2f} / MA20 {mk['ma20']:.2f} / MA60 {mk['ma60']:.2f} / MA120 {mk['ma120']:.2f}（{mk['ma_pos']}）")
    print(f"泡沫顶 {mk['top']['price']:.2f} @ {mk['top']['date']}" + ("（上方套牢盘）" if mk["top"]["is_trap"] else ""))
    print(f"突破确认位 {mk['breakout']:.2f} | 双底生死线 {mk['support']:.2f} | 双底识别: {'是' if mk['double_bottom'] else '否'}")
    print(f"回踩点: {mk['retest']['price']:.2f} @ {mk['retest']['date']}" if mk["retest"] else "回踩点: 未识别")
