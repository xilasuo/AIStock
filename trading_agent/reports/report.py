"""本地报告生成（对应架构「执行回写 + 推送提醒」的本地落地）

产出：
  - reports/report_YYYYMMDD_HHMM.md   可读报告
  - reports/report_YYYYMMDD_HHMM.json 结构化数据
  - reports/equity_YYYYMMDD_HHMM.csv   组合净值曲线（供自行绘图）
"""
from __future__ import annotations

import csv
import glob
import json
import os
from datetime import datetime

import config


def _pct(x: float) -> str:
    return f"{x * 100:+.2f}%" if x is not None else "-"


def _sparkline(equity: list[float], width: int = 40) -> str:
    if not equity:
        return ""
    lo, hi = min(equity), max(equity)
    if hi - lo < 1e-9:
        return "─" * width
    chars = " ▁▂▃▄▅▆▇█"
    step = max(1, len(equity) // width)
    out = []
    for i in range(0, len(equity), step):
        v = (equity[i] - lo) / (hi - lo)
        out.append(chars[min(8, int(v * 8))])
    return "".join(out)


def write_report(result: dict, cfg: config.AppConfig) -> str:
    os.makedirs(config.REPORT_DIR, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    md_path = os.path.join(config.REPORT_DIR, f"report_{ts}.md")
    json_path = os.path.join(config.REPORT_DIR, f"report_{ts}.json")
    csv_path = os.path.join(config.REPORT_DIR, f"equity_{ts}.csv")

    meta = result["meta"]
    selected = result["selected"]
    base = result["base"]
    final = result["final"]
    opt = result.get("optimized")

    lines = []
    lines.append("# 交易 Agent · 闭环运行报告")
    lines.append("")
    lines.append(f"- 生成时间：{meta['generated_at']}")
    lines.append(f"- 行情区间：{meta['beg']} ~ {meta['end']}")
    lines.append(f"- 候选池：{meta['universe_size']} 只 → 选出：{meta['selected_n']} 只（目标 top_n={meta['top_n']}）")
    lines.append(f"- 触达方式：{meta['notifier']}")
    ms = result.get("market_state") or {}
    if ms:
        st = ms.get("state", "unknown")
        pf = ms.get("position_factor", 1.0)
        lines.append(f"- 市场状态：{st}（仓位系数 {pf:.2f}）— {ms.get('detail', '')}")
        # 领先信号（短期动量 / 波动率收缩比），与前端市场状态卡片一致
        sm = ms.get("short_mom")
        vr = ms.get("vol_ratio")
        if sm is not None or vr is not None:
            parts = []
            if sm is not None:
                parts.append(f"短期动量 {_pct(sm)}")
            if vr is not None:
                parts.append(f"波动比 {vr:.2f}")
            if parts:
                lines.append(f"- 领先信号：{' ｜ '.join(parts)}")
    lines.append("")
    lines.append("## 一、选票结果（多因子打分 Top）")
    lines.append("")
    # 实际生效权重说明（预设失真透明化）：列出本轮真实参与的因子及其权重，
    # 以及因数据缺失被剔除的因子。与前端 screenerMeta 展示保持一致。
    _scr = result.get("screener") or {}
    _applied = {k: v for k, v in (_scr.get("applied") or {}).items() if v > 0}
    _skipped = _scr.get("skipped") or []
    if _applied:
        _applied_str = ", ".join(f"{k}={v*100:.0f}%" for k, v in _applied.items())
        lines.append(f"> 实际生效权重：{_applied_str}")
        if _skipped:
            lines.append(f"> 被剔除因子（数据缺失，权重已重新分摊）：{'、'.join(_skipped)}")
        lines.append("")
    lines.append("| 代码 | 名称 | 行业 | 得分 | 动量(20d) | RSI | PE(TTM) | PB | 换手率% | 资金流‰ | 信号数 |")
    lines.append("|------|------|------|------|-----------|-----|----------|----|----------|----------|--------|")
    for r in selected:
        ffp = r.get("fund_flow_pct")
        ffp_str = f"{ffp:.2f}" if ffp is not None else "-"
        lines.append(
            f"| {r['code']} | {r['name']} | {r.get('sector', '其他')} | {r['score']:.3f} | "
            f"{_pct(r['momentum'])} | {r.get('rsi', 0):.1f} | {r['pe_ttm']:.2f} | {r['pb']:.2f} | "
            f"{r['turnover']:.2f} | {ffp_str} | {r.get('n_signals', 0)} |"
        )
    lines.append("")

    lines.append("## 二、回测指标")
    lines.append("")
    lines.append(f"**基准信号参数**：快线 MA{base['signal']['fast_ma']} / 慢线 MA{base['signal']['slow_ma']}")
    bm = base["metrics"]
    lines.append(
        f"- 总收益：{_pct(bm['total_return'])} ｜ 年化：{_pct(bm['annual_return'])} ｜ "
        f"夏普：{bm['sharpe']:.2f} ｜ 最大回撤：{_pct(bm['max_drawdown'])} ｜ "
        f"交易胜率：{_pct(bm['win_rate'])} ｜ 交易次数：{bm.get('trades', 0)}"
    )
    lines.append("")

    if opt:
        fm = final["metrics"]
        bs = opt["best_signal"]
        lines.append(f"**优化后最佳参数**：快线 MA{bs['fast_ma']} / 慢线 MA{bs['slow_ma']}")
        lines.append(
            f"- 总收益：{_pct(fm['total_return'])} ｜ 年化：{_pct(fm['annual_return'])} ｜ "
            f"夏普：{fm['sharpe']:.2f} ｜ 最大回撤：{_pct(fm['max_drawdown'])} ｜ "
            f"交易胜率：{_pct(fm['win_rate'])} ｜ 交易次数：{fm.get('trades', 0)}"
        )
        imp = fm["sharpe"] - bm["sharpe"]
        lines.append(f"- 夏普提升：{imp:+.2f}（优化{ '有效' if imp > 0 else '未超越基准'}）")
        # 样本外绩效（诚实呈现，防过拟合）
        oos = opt.get("out_of_sample") or {}
        oos_m = oos.get("metrics") or {}
        split = opt.get("split") or {}
        if oos_m:
            lines.append("")
            lines.append("**样本外验证（时间序列切分，防过拟合）**")
            lines.append(
                f"- 总收益：{_pct(oos_m['total_return'])} ｜ 年化：{_pct(oos_m['annual_return'])} ｜ "
                f"夏普：{oos_m['sharpe']:.2f} ｜ 最大回撤：{_pct(oos_m['max_drawdown'])} ｜ "
                f"交易胜率：{_pct(oos_m.get('win_rate', 0.0))} ｜ 交易次数：{oos_m.get('trades', 0)}"
            )
            tr = split.get("train_ratio", 0.7)
            lines.append(f"- 切分：前 {tr*100:.0f}% 训练选参，后 {(1-tr)*100:.0f}% 样本外验证")
            lines.append("")
        lines.append("")
        lines.append("### 网格搜索 Top 结果")
        lines.append("")
        lines.append("| 快线 | 慢线 | 目标(夏普) | 总收益 | 最大回撤 |")
        lines.append("|------|------|-----------|--------|----------|")
        for g in opt["grid"][:8]:
            lines.append(
                f"| {g['fast_ma']} | {g['slow_ma']} | {g['metric']:.3f} | "
                f"{_pct(g['total_return'])} | {_pct(g['max_drawdown'])} |"
            )
        lines.append("")

    lines.append("## 三、真实历史模拟（滚动再平衡回测）")
    lines.append("")
    wf = result.get("walk_forward")
    if wf:
        wm = wf["metrics"]
        lines.append(f"> 消除幸存者偏差：每期只用「截至当期」的数据重选票，按等权与单票风险预算建仓。")
        lines.append(
            f"- 总收益：{_pct(wm['total_return'])} ｜ 年化：{_pct(wm['annual_return'])} ｜ "
            f"夏普：{wm['sharpe']:.2f} ｜ 最大回撤：{_pct(wm['max_drawdown'])} ｜ "
            f"交易胜率：{_pct(wm['win_rate'])} ｜ 交易次数：{wm.get('trades', 0)}"
        )
        lines.append(f"- 再平衡周期：{wf.get('rebalance_days', 20)} 个交易日")
    else:
        lines.append("- （候选池或历史数据不足，未生成真实历史模拟）")
    lines.append("")

    lines.append("## 四、组合净值曲线")
    lines.append("")
    lines.append(f"```")
    lines.append(_sparkline(final["equity"]))
    lines.append(f"```")
    lines.append("")
    eq = final["equity"]
    if eq:
        lines.append(f"- 净值起点：{eq[0]:.4f} → 终点：{eq[-1]:.4f}（起始归一化 1.0）")
        lines.append(f"- 交易日数：{len(eq)} ｜ 信号总数：{final.get('n_signals_total', 0)}")
    lines.append("")
    lines.append("## 五、说明")
    lines.append("")
    lines.append("- 本系统为**分析 / 回测 / 模拟**框架，所有结果基于历史数据，不构成投资建议，亦不进行真实资金下单。")
    lines.append("- 数据来源：腾讯财经（估值）+ 东财前复权日线（主）/ 新浪日 K 线（兜底），均为免 key 公开接口；统一前复权口径避免除权失真。")
    lines.append("- 触达层当前为本地报告；如需微信/App 推送，需连接 westock / 微信类连接器；邮件推送需启用 agent-mail。")
    lines.append("")

    with open(md_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))

    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2, default=str)

    with open(csv_path, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["date", "equity"])
        for d, e in zip(final["dates"], final["equity"]):
            w.writerow([d, e])

    return md_path


def _json_default(o):
    """兼容 numpy 标量等不可直接序列化的数值类型。"""
    try:
        return float(o)
    except (TypeError, ValueError):
        return str(o)


def _market_state_view(ms: dict) -> dict:
    """把市场状态字典整理为前端友好的 camelCase 字段。"""
    return {
        "state": ms.get("state", "unknown"),
        "positionFactor": float(ms.get("position_factor", 1.0)),
        "score": float(ms.get("score", 0.0)),
        "detail": ms.get("detail", ""),
        "maGap": float(ms.get("ma_gap", 0.0)),
        "momentum": float(ms.get("momentum", 0.0)),
        "shortMom": float(ms.get("short_mom", 0.0)),
        "volRatio": float(ms.get("vol_ratio", 1.0)),
    }


def write_scan_json(result: dict, cfg: config.AppConfig) -> str:
    """文件桥：把闭环结果写成结构化 JSON 到共享目录，供 AIStock 读取展示。

    输出：<SCAN_SHARE_DIR>/latest.json（总是覆盖最新一份）。
    字段命名采用 camelCase，方便 TypeScript 前端直接消费。
    """
    os.makedirs(config.SCAN_SHARE_DIR, exist_ok=True)
    out_path = os.path.join(config.SCAN_SHARE_DIR, "latest.json")

    meta = result["meta"]

    selected = [
        {
            "code": r["code"],
            "name": r["name"],
            "sector": r.get("sector", "其他"),
            "score": round(float(r["score"]), 4),
            "momentum": float(r["momentum"]),
            "peTtm": float(r["pe_ttm"]),
            "pb": float(r["pb"]),
            "turnover": float(r["turnover"]),
            "signals": int(r.get("n_signals", 0)),
            # —— 选出时间：个股信号时点（K 线最新 bar 日期）+ 整批扫描时刻 ——
            # signalTime: 该股被选出的信号依据行情日（盘后=当日，盘前/盘中=最新交易日）；
            # selectedAt: 本次扫描生成的时刻（与顶层 generatedAt 一致）。
            "signalTime": r.get("signal_time") or "",
            "selectedAt": meta["generated_at"],
            # —— 新增因子维度（丰富选股策略）——
            "rsi": round(float(r.get("rsi", 0.0)), 2),
            "riskAdjMomentum": round(float(r.get("risk_adj_momentum", 0.0)), 4),
            "macd": round(float(r.get("macd", 0.0)), 4),
            "trend": round(float(r.get("trend", 0.0)), 4),
            "factors": {k: float(v) for k, v in (r.get("factor_scores") or {}).items()},
            # —— 入选理由（解释性）：screener 生成的一句话入选逻辑 ——
            "rationale": r.get("rationale") or "",
            # —— 质量因子（接数据源后才有；ROE / 股息率）——
            "roe": (float(r["roe"]) if r.get("roe") is not None else None),
            "dividendYield": (float(r["dividend_yield"]) if r.get("dividend_yield") is not None else None),
            # —— 资金流因子（主力净流入占流通市值千分比；数据源未提供则 None）——
            "fundFlowPct": (float(r["fund_flow_pct"]) if r.get("fund_flow_pct") is not None else None),
        }
        for r in result["selected"]
    ]

    def metrics_view(m: dict) -> dict:
        return {
            "totalReturn": float(m.get("total_return", 0.0)),
            "annualReturn": float(m.get("annual_return", 0.0)),
            "sharpe": float(m.get("sharpe", 0.0)),
            "maxDrawdown": float(m.get("max_drawdown", 0.0)),
            "winRate": float(m.get("win_rate", 0.0)),
            "trades": int(m.get("trades", 0)),
        }

    base_sig = result["base"]["signal"]
    final_sig = result["final"]["signal"]
    base_m = metrics_view(result["base"]["metrics"])
    final_m = metrics_view(result["final"]["metrics"])

    payload = {
        "generatedAt": meta["generated_at"],
        "period": {"beg": meta["beg"], "end": meta["end"]},
        "universeSize": int(meta["universe_size"]),
        "selectedCount": int(meta["selected_n"]),
        "marketState": _market_state_view(result.get("market_state") or {}),
        "screenerMeta": {
            "configured": {k: float(v) for k, v in (result.get("screener") or {}).get("configured", {}).items()},
            "applied": {k: float(v) for k, v in (result.get("screener") or {}).get("applied", {}).items()},
            "skipped": list((result.get("screener") or {}).get("skipped", [])),
        },
        "selected": selected,
        "backtest": {
            "baseSignal": {"fastMa": int(base_sig["fast_ma"]), "slowMa": int(base_sig["slow_ma"])},
            "baseMetrics": base_m,
            "finalSignal": {"fastMa": int(final_sig["fast_ma"]), "slowMa": int(final_sig["slow_ma"])},
            "finalMetrics": final_m,
        },
        "equityCurve": [
            {"date": d, "value": float(e)}
            for d, e in zip(result["final"]["dates"], result["final"]["equity"])
        ],
    }

    opt = result.get("optimized")
    if opt:
        oos = opt.get("out_of_sample") or {}
        oos_metrics = oos.get("metrics") or {}
        oos_view = metrics_view(oos_metrics) if oos_metrics else None
        payload["backtest"]["optimized"] = {
            "bestSignal": {
                "fastMa": int(opt["best_signal"]["fast_ma"]),
                "slowMa": int(opt["best_signal"]["slow_ma"]),
            },
            "bestMetrics": final_m,
            "sharpeImprovement": round(final_m["sharpe"] - base_m["sharpe"], 4),
            "grid": [
                {
                    "fastMa": int(g["fast_ma"]),
                    "slowMa": int(g["slow_ma"]),
                    "metric": float(g["metric"]),
                    "totalReturn": float(g["total_return"]),
                    "maxDrawdown": float(g["max_drawdown"]),
                }
                for g in opt["grid"][:8]
            ],
            # 样本外绩效（时间序列切分验证，防过拟合）；前端/报告应优先展示此项
            "outOfSample": oos_view,
            "split": {
                "trainRatio": float(opt.get("split", {}).get("train_ratio", 0.7)),
                "testBars": dict(opt.get("split", {}).get("test_bars", {})),
            },
        }

    # 真实历史模拟（滚动再平衡回测，消除幸存者偏差）
    wf = result.get("walk_forward")
    if wf:
        wf_m = wf.get("metrics") or {}
        payload["walkForward"] = {
            "metrics": metrics_view(wf_m),
            "rebalanceDays": int(wf.get("rebalance_days", 20)),
            "equityCurve": [
                {"date": d, "value": float(e)}
                for d, e in zip(wf.get("dates", []), wf.get("equity", []))
            ],
        }

    payload["disclaimer"] = (
        "本结果基于历史数据回测与样本外验证，仅供研究参考，不构成投资建议，"
        "亦不进行真实资金下单。回测绩效不代表未来收益。"
    )

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2, default=_json_default)
    # 返回 payload 供云端推送复用（同一份结构化数据）
    return payload


def prune_reports(max_keep: int = 20) -> int:
    """本地报告轮转：保留最近 max_keep 次运行，删除更早的（含同组的 .md/.json/.csv）。

    报告按时间戳前缀 YYYYMMDD_HHMMSS 分组，整组的 3 个文件一起保留/删除。
    max_keep 由环境变量 REPORT_KEEP 覆盖（<=0 表示不清理）。
    返回删除的文件数。云端文件（latest.json 单文件覆盖）不受影响。
    """
    max_keep = int(os.environ.get("REPORT_KEEP", str(max_keep)))
    if max_keep <= 0:
        return 0

    groups: dict[str, list[str]] = {}
    for p in glob.glob(os.path.join(config.REPORT_DIR, "report_*.md")):
        base = os.path.basename(p)
        ts = base[len("report_"):-len(".md")]  # YYYYMMDD_HHMMSS
        grp = groups.setdefault(ts, [p])
        j = p[:-len(".md")] + ".json"
        c = os.path.join(config.REPORT_DIR, "equity_" + ts + ".csv")
        for extra in (j, c):
            if os.path.exists(extra):
                grp.append(extra)

    ordered = sorted(groups.keys(), reverse=True)  # 最新在前
    to_delete: list[str] = []
    for ts in ordered[max_keep:]:
        to_delete.extend(groups[ts])
    for fp in to_delete:
        try:
            os.remove(fp)
        except OSError:
            pass
    return len(to_delete)
