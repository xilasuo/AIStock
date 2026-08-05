"""中枢驱动：消费 WorkBuddy 中枢写出的 prefetched.json，跑纯引擎闭环。

分工（WorkBuddy 当中枢架构）：
  - 枢纽（本会话 / 定时 automation）负责：用 tdx-connector / westock-mcp 取数，
    把数据写成 prefetched.json，再把运行结果推送出去。
  - 本脚本只做纯计算：选票 -> 信号 -> 回测 -> 优化，产出
      scan_payload.json : 推送云端/企业微信的内容（write_scan_json 同款结构）
      signals_out.json  : 候选 BUY 信号（含最新收盘价，供枢纽回写）

可选推送：若传入 --push-url（或环境变量 CLOUD_WRITEBACK_URL）与 --push-token
（或环境变量 CLOUD_SCAN_TOKEN），会把候选回写信号包装为回写载荷 POST 到该地址，
供云端「回写结果」页展示。未传入则只在本地写出 signals_out.json。

prefetched.json schema：
{
  "universe": ["600519", ...],          # 可选；缺省用 klines 的全部 code
  "config":   { "top_n": 8, "momentum_window": 20, "fast_ma": 5,
                "slow_ma": 10, "optim_enabled": false, ... },  # 可选覆盖
  "klines": { "600519": [ {"date","open","high","low","close","volume","amount"}, ... ] },
  "quotes": { "600519": { "name","price","pe_ttm","pb","turnover_pct","change_pct" } },
  "hot":    []
}
字段命名做了兼容：tdx 的 Data/Open/Close 与 westock 的 pe_ratio/pb_ratio 都会被归一化。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def _load_dotenv():
    """加载项目根目录 .env 到 os.environ（若存在），使本地直接运行也能读到
    CLOUD_BASE_URL / CLOUD_CFG_USER 等，无需手动 export。"""
    here = os.path.dirname(os.path.abspath(__file__))
    for cand in (os.path.join(here, "..", ".env"), os.path.join(here, ".env")):
        if os.path.isfile(cand):
            with open(cand, encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    k, v = line.split("=", 1)
                    k, v = k.strip(), v.strip().strip('"').strip("'")
                    os.environ.setdefault(k, v)
            break


_load_dotenv()

import config
from data.provider import StaticProvider, default_provider
from hub import run as hub_run, _build_signals
from strategy import presets
from timeutil import sh_now, sh_now_aware


def _norm_bar(b: dict) -> dict:
    def g(*ks):
        for k in ks:
            if k in b and b[k] not in (None, ""):
                return b[k]
        return None

    return {
        "date": g("date", "Data"),
        "open": float(g("open", "Open") or 0),
        "high": float(g("high", "High") or 0),
        "low": float(g("low", "Low") or 0),
        "close": float(g("close", "Close") or 0),
        "volume": float(g("volume", "Volume", "vol", "VolInStock") or 0),
        "amount": float(g("amount", "Amount") or 0),
    }


def _norm_quote(q: dict, code: str) -> dict:
    def g(*ks):
        for k in ks:
            if k in q and q[k] not in (None, ""):
                return q[k]
        return None

    return {
        "name": g("name") or code,
        "price": float(g("price") or 0),
        "pe_ttm": float(g("pe_ttm", "pe_ratio") or 0),
        "pb": float(g("pb", "pb_ratio") or 0),
        "turnover_pct": float(g("turnover_pct", "turnover_rate") or 0),
        "change_pct": float(g("change_pct", "change_percent") or 0),
        "mcap_yi": float(g("mcap_yi", "float_mcap_yi", "total_mv", "market_cap") or 0),
        "float_mcap_yi": (float(g("float_mcap_yi", "float_market_cap")) if g("float_mcap_yi", "float_market_cap") not in (None, "") else None),
        # 质量因子（ROE / 股息率）；缺省为 None，screener 据此判断是否启用质量因子
        "roe": (float(g("roe")) if g("roe") not in (None, "") else None),
        "dividend_yield": (float(g("dividend_yield", "dividendYield")) if g("dividend_yield", "dividendYield") not in (None, "") else None),
        # 主力资金流（元）；缺省为 None，screener 据此判断是否启用资金流因子
        "fund_flow": (float(g("fund_flow", "main_net_inflow")) if g("fund_flow", "main_net_inflow") not in (None, "") else None),
    }


def load_prefetched(path: str):
    with open(path, "r", encoding="utf-8") as f:
        raw = json.load(f)
    klines = {c: [_norm_bar(b) for b in bars] for c, bars in raw.get("klines", {}).items()}
    # 合并基本面（ROE / 股息率）：中枢可取数后写入 prefetched["fundamentals"]
    raw_quotes = raw.get("quotes", {})
    fundamentals = raw.get("fundamentals") or {}
    for c, f in fundamentals.items():
        if c in raw_quotes and f:
            raw_quotes[c]["roe"] = f.get("roe")
            raw_quotes[c]["dividend_yield"] = f.get("dividend_yield")
    quotes = {c: _norm_quote(q, c) for c, q in raw_quotes.items()}
    hot = raw.get("hot", [])
    codes = raw.get("universe") or list(klines.keys())
    return klines, quotes, hot, codes, raw.get("config", {})


def pull_cloud_overrides(url: str, user: str, password: str, profile: str = "pre_market"):
    """登录云端并拉取策略扫描配置，摊平为 overrides；同时返回溯源凭证 receipt。

    profile: 时段档位（pre_market/intraday/post_market）。云端配置可能为分档结构
    {profiles:{pre_market:{...},intraday:{...},post_market:{...}}}，此时只提取该档
    的配置再摊平；旧全局结构（无 profiles 键）视为 pre_market 档，向后兼容。

    返回 (overrides: dict, cookie: str|None, receipt: dict)。云端不执行引擎、只维护配置；
    本地程序（含 WorkBuddy 中枢调用的 run_hub）以此先拉取云端配置再执行。
    网络/鉴权失败则返回 ({}, None, receipt)，receipt.source="local-fallback"，不阻断本地流程。
    cookie 为登录会话串（成功时非空），可被推送扫描结果复用，使云端按登录用户写入隔离结果。

    receipt 关键字段（供邮件溯源与独立复算）：
      source        : "cloud" | "local-fallback"
      base_url      : 云端基地址
      endpoint      : "/api/strategy-scan/config"
      fetched_at    : 拉取时间（本地时区，含偏移）
      http_status   : HTTP 状态码（失败为 None/0）
      login_ok      : 是否拿到 session
      config_sha256 : 原始返回 JSON 的 SHA-256（用户可独立复算比对）
      config_keys   : 摊平后的配置键列表
      note          : 人类可读说明（含回退原因）
    """
    receipt = {
        "source": "local-fallback",
        "base_url": url or "",
        "endpoint": "/api/strategy-scan/config",
        "fetched_at": sh_now_aware().strftime("%Y-%m-%d %H:%M:%S %z"),
        "http_status": None,
        "login_ok": False,
        "config_sha256": "",
        "config_keys": [],
        "note": "",
    }
    if not url or not user or not password:
        receipt["note"] = "未提供完整云端凭据，跳过云端配置拉取（回退本地 strategy_config.yaml）"
        return {}, None, receipt
    try:
        import pull_cloud_config as pcc
    except Exception as e:  # noqa: BLE001
        receipt["note"] = f"导入 pull_cloud_config 失败，跳过云端配置: {e}"
        return {}, None, receipt
    cookie = pcc.login(url, user, password)
    if not cookie:
        receipt["note"] = "云端登录失败（凭据/网络不可达），已回退本地 strategy_config.yaml"
        return {}, None, receipt
    receipt["login_ok"] = True
    try:
        status, obj, raw = pcc.fetch_cloud_config_raw(url, cookie)
    except Exception as e:  # noqa: BLE001
        receipt["note"] = f"获取云端配置异常: {e}，已回退本地"
        return {}, cookie, receipt
    receipt["http_status"] = status
    if not obj:
        receipt["note"] = f"云端返回异常（HTTP {status}），已回退本地 strategy_config.yaml"
        return {}, cookie, receipt
    nested = obj.get("config") or {}
    # 分档提取：云端配置为 {profiles:{...}} 时只取当前档；旧结构（无 profiles）视为 pre_market 档
    is_profiles = isinstance(nested, dict) and isinstance(nested.get("profiles"), dict)
    if is_profiles:
        profiles = nested["profiles"]
        chosen = profiles.get(profile) or profiles.get("pre_market") or {}
        nested = chosen if isinstance(chosen, dict) else {}
    try:
        receipt["config_sha256"] = hashlib.sha256(raw.encode("utf-8")).hexdigest()
    except Exception:  # noqa: BLE001
        receipt["config_sha256"] = ""
    overrides = pcc.to_overrides(nested)
    receipt["config_keys"] = sorted(overrides.keys())
    receipt["source"] = "cloud"
    receipt["note"] = "策略配置已从云端拉取并应用" + (f" [profile={profile}]" if is_profiles else "")
    return overrides, cookie, receipt


def _write_cloud_receipt(receipt: dict, out_dir: str):
    """写出云端策略溯源凭证，供中枢/邮件取证与独立复算。"""
    try:
        os.makedirs(out_dir, exist_ok=True)
        path = os.path.join(out_dir, "cloud_strategy_receipt.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(receipt, f, ensure_ascii=False, indent=2)
        print(f"已写出云端策略溯源凭证: {path}")
    except Exception as e:  # noqa: BLE001
        print(f"写出溯源凭证失败: {e}")


def _write_scan_summary(payload: dict, profile: str, out_dir: str):
    """轻量入选摘要（几 KB），供中枢报告步骤读取，避免整读 49KB scan_payload.json。"""
    try:
        os.makedirs(out_dir, exist_ok=True)
        sel = payload.get("selected", [])
        summary = {
            "generatedAt": payload.get("generatedAt"),
            "period": payload.get("period"),
            "universeSize": payload.get("universeSize"),
            "selectedCount": payload.get("selectedCount"),
            "profile": profile,
            "marketState": payload.get("marketState"),
            # 回测基准指标（来自 payload.backtest.baseMetrics），使中枢报告步骤
            # 无需整读 49KB scan_payload.json 即可拿到收益/夏普等关键数字。
            "backtest": payload.get("backtest", {}).get("baseMetrics", {}),
            "selected": [
                {
                    "code": r.get("code"),
                    "name": r.get("name"),
                    "sector": r.get("sector"),
                    "score": r.get("score"),
                    "momentum": r.get("momentum"),
                    "peTtm": r.get("peTtm"),
                    "pb": r.get("pb"),
                    "turnover": r.get("turnover"),
                    "rsi": r.get("rsi"),
                    "macd": r.get("macd"),
                    "trend": r.get("trend"),
                }
                for r in sel
            ],
        }
        path = os.path.join(out_dir, "scan_summary.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(summary, f, ensure_ascii=False, indent=2)
        print(f"已写出入选摘要: {path}")
    except Exception as e:  # noqa: BLE001
        print(f"写出入选摘要失败: {e}")


def _write_strategy_snapshot(cfg, receipt: dict, profile: str, out_dir: str):
    """策略快照（关键参数提炼），供中枢报告步骤读取，避免二次拉取完整云端配置。"""
    try:
        os.makedirs(out_dir, exist_ok=True)
        s = getattr(cfg, "screener", None)
        m = getattr(cfg, "market", None)
        sig = getattr(cfg, "signal", None)
        o = getattr(cfg, "optim", None)
        sha = (receipt.get("config_sha256") or "")[:8]
        snap = {
            "profile": profile,
            "source": receipt.get("source"),
            "config_sha256_8": sha,
            "fetched_at": receipt.get("fetched_at"),
            "screener": {
                "top_n": getattr(s, "top_n", None),
                "max_per_sector": getattr(s, "max_per_sector", None),
                "momentum_window": getattr(s, "momentum_window", None),
                "w_momentum": getattr(s, "w_momentum", None),
                "w_value": getattr(s, "w_value", None),
                "w_liquidity": getattr(s, "w_liquidity", None),
                "w_rsi": getattr(s, "w_rsi", None),
                "w_macd": getattr(s, "w_macd", None),
                "w_trend": getattr(s, "w_trend", None),
                "w_size": getattr(s, "w_size", None),
                "w_quality": getattr(s, "w_quality", None),
                "w_fund_flow": getattr(s, "w_fund_flow", None),
            },
            "market": {
                "enable": getattr(m, "enable", None),
                "index_code": getattr(m, "index_code", None),
                "ma_window": getattr(m, "ma_window", None),
            },
            "signal": {
                "use_breakout_filter": getattr(sig, "use_breakout_filter", None),
                "breakout_window": getattr(sig, "breakout_window", None),
                "fast_ma": getattr(sig, "fast_ma", None),
                "slow_ma": getattr(sig, "slow_ma", None),
                "stop_loss_pct": getattr(sig, "stop_loss_pct", None),
                "max_positions": getattr(sig, "max_positions", None),
            },
            "optim": {"enabled": getattr(o, "enabled", None)},
        }
        path = os.path.join(out_dir, "strategy_snapshot.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(snap, f, ensure_ascii=False, indent=2)
        print(f"已写出策略快照: {path}")
    except Exception as e:  # noqa: BLE001
        print(f"写出策略快照失败: {e}")


def apply_config(cfg: config.AppConfig, ov: dict):
    sc = cfg.screener
    if "top_n" in ov:
        sc.top_n = int(ov["top_n"])
    if "max_per_sector" in ov:
        sc.max_per_sector = int(ov["max_per_sector"])
    if "momentum_window" in ov:
        sc.momentum_window = int(ov["momentum_window"])
    if "min_turnover_pct" in ov:
        sc.min_turnover_pct = float(ov["min_turnover_pct"])
    if "max_pe_ttm" in ov:
        sc.max_pe_ttm = float(ov["max_pe_ttm"])
    if "max_pb" in ov:
        sc.max_pb = float(ov["max_pb"])
    if "w_momentum" in ov:
        sc.w_momentum = float(ov["w_momentum"])
    if "w_value" in ov:
        sc.w_value = float(ov["w_value"])
    if "w_liquidity" in ov:
        sc.w_liquidity = float(ov["w_liquidity"])
    if "w_rsi" in ov:
        sc.w_rsi = float(ov["w_rsi"])
    if "w_macd" in ov:
        sc.w_macd = float(ov["w_macd"])
    if "w_trend" in ov:
        sc.w_trend = float(ov["w_trend"])
    if "w_size" in ov:
        sc.w_size = float(ov["w_size"])
    if "w_quality" in ov:
        sc.w_quality = float(ov["w_quality"])
    if "w_fund_flow" in ov:
        sc.w_fund_flow = float(ov["w_fund_flow"])
    if "rsi_window" in ov:
        sc.rsi_window = int(ov["rsi_window"])
    if "macd_fast" in ov:
        sc.macd_fast = int(ov["macd_fast"])
    if "macd_slow" in ov:
        sc.macd_slow = int(ov["macd_slow"])
    if "macd_signal" in ov:
        sc.macd_signal = int(ov["macd_signal"])
    if "vol_window" in ov:
        sc.vol_window = int(ov["vol_window"])
    if "fast_ma" in ov:
        cfg.signal.fast_ma = int(ov["fast_ma"])
    if "slow_ma" in ov:
        cfg.signal.slow_ma = int(ov["slow_ma"])
    if "use_breakout_filter" in ov:
        cfg.signal.use_breakout_filter = bool(ov["use_breakout_filter"])
    if "optim_enabled" in ov:
        cfg.optim.enabled = bool(ov["optim_enabled"])
    if "stop_loss_pct" in ov:
        cfg.signal.stop_loss_pct = float(ov["stop_loss_pct"])
    # 市场状态（风控前置）
    if "market_enable" in ov:
        cfg.market.enable = bool(ov["market_enable"])
    if "index_code" in ov:
        cfg.market.index_code = str(ov["index_code"])
    # signal 段补充（预设/云端配置常用、但此前 apply_config 漏接的键）
    if "breakout_window" in ov:
        cfg.signal.breakout_window = int(ov["breakout_window"])
    if "max_positions" in ov:
        cfg.signal.max_positions = int(ov["max_positions"])
    # 市场状态（风控前置）调参键
    if "ma_window" in ov:
        cfg.market.ma_window = int(ov["ma_window"])
    if "mom_window" in ov:
        cfg.market.mom_window = int(ov["mom_window"])
    if "short_mom_window" in ov:
        cfg.market.short_mom_window = int(ov["short_mom_window"])
    if "strong_short_mom" in ov:
        cfg.market.strong_short_mom = float(ov["strong_short_mom"])
    if "weak_short_mom" in ov:
        cfg.market.weak_short_mom = float(ov["weak_short_mom"])
    if "vol_shrink_threshold" in ov:
        cfg.market.vol_shrink_threshold = float(ov["vol_shrink_threshold"])
    if "neutral_up_factor" in ov:
        cfg.market.neutral_up_factor = float(ov["neutral_up_factor"])
    if "neutral_down_factor" in ov:
        cfg.market.neutral_down_factor = float(ov["neutral_down_factor"])
    if "bull_ma_gap" in ov:
        cfg.market.bull_ma_gap = float(ov["bull_ma_gap"])
    if "bear_ma_gap" in ov:
        cfg.market.bear_ma_gap = float(ov["bear_ma_gap"])
    if "bull_mom" in ov:
        cfg.market.bull_mom = float(ov["bull_mom"])
    if "bear_mom" in ov:
        cfg.market.bear_mom = float(ov["bear_mom"])
    # 前置条件过滤（板块 / ST / 流通市值）
    if "boards" in ov:
        cfg.screener.boards = list(ov["boards"])
    if "st_filter" in ov:
        cfg.screener.st_filter = str(ov["st_filter"])
    if "mcap_min" in ov:
        cfg.screener.mcap_min = float(ov["mcap_min"])
    if "mcap_max" in ov:
        cfg.screener.mcap_max = float(ov["mcap_max"])


def push_writeback(url: str, token: str, payload: dict, cookie: str | None = None) -> bool:
    """把候选回写载荷 POST 到云端 /api/writeback-signals。

    cookie 为登录会话串（来自 pull_cloud_overrides 的复用）。携带时云端按登录用户
    写入隔离回写桶（user_id=本人）；不携带则仅 token 鉴权，落入全局桶（兼容老自动化）。
    """
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    headers: dict = {
        "Content-Type": "application/json",
        "x-push-token": token,
    }
    if cookie:
        headers["Cookie"] = cookie
    req = Request(
        url,
        data=data,
        method="POST",
        headers=headers,
    )
    try:
        with urlopen(req, timeout=15) as resp:
            ok = resp.status == 200
            print(f"回写推送 {'成功' if ok else '失败'} (HTTP {resp.status}) -> {url}")
            return ok
    except HTTPError as e:
        print(f"回写推送被拒绝 (HTTP {e.code}): {e.read().decode('utf-8', 'replace')[:200]}")
    except URLError as e:
        print(f"回写推送失败（网络/地址错误）: {e.reason}")
    except Exception as e:  # noqa: BLE001
        print(f"回写推送异常: {e}")
    return False


def push_scan(url: str, token: str, payload: dict, cookie: str | None = None) -> bool:
    """把扫描结果 POST 到云端 /api/strategy-scan。

    cookie 为登录会话串（来自 pull_cloud_overrides 的复用）。携带时云端按登录用户
    写入隔离结果桶（user_id=本人）；不携带则仅 token 鉴权，落入全局桶（兼容老自动化）。
    """
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    headers: dict = {
        "Content-Type": "application/json",
        "x-push-token": token,
    }
    if cookie:
        headers["Cookie"] = cookie
    req = Request(
        url,
        data=data,
        method="POST",
        headers=headers,
    )
    try:
        with urlopen(req, timeout=15) as resp:
            ok = resp.status == 200
            print(f"扫描推送 {'成功' if ok else '失败'} (HTTP {resp.status}) -> {url}")
            return ok
    except HTTPError as e:
        print(f"扫描推送被拒绝 (HTTP {e.code}): {e.read().decode('utf-8', 'replace')[:200]}")
    except URLError as e:
        print(f"扫描推送失败（网络/地址错误）: {e.reason}")
    except Exception as e:  # noqa: BLE001
        print(f"扫描推送异常: {e}")
    return False


def build_writeback_payload(signals: list[dict]) -> dict:
    return {
        "generatedAt": sh_now().isoformat(timespec="seconds"),
        "dryRun": True,
        "channel": "tdx-connector（本环境仅查询工具，无 place_order；回写为模拟 dry-run）",
        "signals": signals,
        "note": (
            "执行回写暂不可用：当前 tdx-connector 未提供下单接口。"
            "以上为候选回写信号，待接入带下单能力的券商 MCP 后切换为真实回写。"
        ),
    }


def render_wechat_digest(payload: dict, signals: list[dict]) -> tuple[str, str]:
    """把选股结果渲染成微信推送用的 (标题, Markdown正文)。"""
    sel = payload.get("selected", [])
    bm = payload.get("backtest", {}).get("baseMetrics", {})
    date = sh_now().strftime("%Y-%m-%d")
    title = f"盘前选股 {date} · 入选 {payload.get('selectedCount', len(sel))} 只"
    lines: list[str] = []
    if sel:
        lines.append("**入选标的**")
        for r in sel:
            lines.append(
                f"- {r['code']} {r.get('name','')}｜得分 {r.get('score',0):.2f}"
                f"｜PE {r.get('peTtm')}｜PB {r.get('pb')}｜动量 {r.get('momentum',0)*100:.1f}%"
            )
    else:
        lines.append("（今日无入选）")
    lines.append("")
    lines.append(
        f"**基准回测**｜交易 {bm.get('trades')}｜总收益 {bm.get('totalReturn')}｜夏普 {bm.get('sharpe')}"
    )
    if signals:
        lines.append("")
        lines.append(f"**候选回写（模拟 dry-run）** {len(signals)} 笔")
        for s in signals:
            lines.append(f"- BUY {s['code']} {s['name']} @ {s['price']} × {s['quantity']}")
        lines.append("")
        lines.append("> 回写为模拟：当前 tdx-connector 无 place_order，待接入下单能力券商后切真。")
    return title, "\n".join(lines)


def push_wechat(payload: dict, signals: list[dict]) -> bool:
    """把选股结果推送到个人微信（经 Server酱 / PushPlus 中转，落点=微信「服务通知」）。

    依赖环境变量：WX_PUSH_DRIVER(serverchan|pushplus) + 对应 Key。
    """
    driver = (os.environ.get("WX_PUSH_DRIVER") or "").lower()
    if not driver or driver == "none":
        return False
    title, desp = render_wechat_digest(payload, signals)
    try:
        if driver == "serverchan":
            key = os.environ.get("SERVERCHAN_KEY") or ""
            if not key:
                print("WX_PUSH_DRIVER=serverchan 但未配置 SERVERCHAN_KEY，跳过微信推送")
                return False
            url = "https://sctapi.ftqq.com/Send"
            data = json.dumps({"sendkey": key, "title": title, "desp": desp}, ensure_ascii=False).encode("utf-8")
            req = Request(url, data=data, method="POST", headers={"Content-Type": "application/json"})
        elif driver == "pushplus":
            token = os.environ.get("PUSHPLUS_TOKEN") or ""
            if not token:
                print("WX_PUSH_DRIVER=pushplus 但未配置 PUSHPLUS_TOKEN，跳过微信推送")
                return False
            url = "http://www.pushplus.plus/send"
            body = {"token": token, "title": title, "content": desp, "template": "markdown"}
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            req = Request(url, data=data, method="POST", headers={"Content-Type": "application/json"})
        else:
            print(f"未知 WX_PUSH_DRIVER={driver}（支持 serverchan / pushplus），跳过微信推送")
            return False
        with urlopen(req, timeout=15) as resp:
            txt = resp.read().decode("utf-8", "replace")
            ok = resp.status == 200
            try:
                obj = json.loads(txt)
                code = obj.get("code")
                ok = ok and (code in (0, 200))
            except Exception:
                pass
            print(f"微信推送（{driver}）{'成功' if ok else '失败'} (HTTP {resp.status})")
            return ok
    except HTTPError as e:
        print(f"微信推送被拒绝 (HTTP {e.code}): {e.read().decode('utf-8', 'replace')[:200]}")
    except URLError as e:
        print(f"微信推送失败（网络/地址错误）: {e.reason}")
    except Exception as e:  # noqa: BLE001
        print(f"微信推送异常: {e}")
    return False


def render_wecom_markdown(payload: dict, signals: list[dict], receipt: dict | None) -> str:
    """把选股结果渲染成企业微信群机器人 webhook 用的 Markdown 正文。"""
    sel = payload.get("selected", [])
    bm = payload.get("backtest", {}).get("baseMetrics", {})
    ms = payload.get("marketState", {}) or {}
    date = sh_now().strftime("%Y-%m-%d")
    lines: list[str] = []
    lines.append(f"# 盘前选股 {date}")
    lines.append("")
    state = ms.get("state", "unknown")
    detail = ms.get("detail", "")
    lines.append(f"**牛熊判定**：{state}（仓位系数 {ms.get('positionFactor', 1.0)}）")
    if detail:
        lines.append(f"> {detail}")
    lines.append("")
    lines.append(f"**入选 {payload.get('selectedCount', len(sel))} 只**（候选池 {payload.get('universeSize', 0)} 只）")
    if sel:
        for r in sel:
            lines.append(
                f"- {r['code']} {r.get('name','')}｜得分 {r.get('score',0):.2f}"
                f"｜PE {r.get('peTtm')}｜PB {r.get('pb')}｜动量 {r.get('momentum',0)*100:.1f}%"
                f"｜RSI {r.get('rsi')}"
            )
    else:
        lines.append("- （今日无入选）")
    lines.append("")
    lines.append(
        f"**基准回测**｜交易 {bm.get('trades')}｜总收益 {bm.get('totalReturn')}｜夏普 {bm.get('sharpe')}"
    )
    if signals:
        lines.append("")
        lines.append(f"**候选回写（模拟 dry-run）** {len(signals)} 笔")
        for s in signals:
            lines.append(f"- BUY {s['code']} {s['name']} @ {s['price']} × {s['quantity']}")
        lines.append("")
        lines.append("> 回写为模拟：当前 tdx-connector 无 place_order，待接入下单能力券商后切真。")
    if receipt:
        lines.append("")
        lines.append("**策略溯源**")
        lines.append(f"- 来源：{receipt.get('source')}")
        sha = receipt.get("config_sha256", "")[:8]
        if sha:
            lines.append(f"- 策略SHA：{sha}")
        note = receipt.get("note", "")
        if note:
            lines.append(f"- 备注：{note}")
    return "\n".join(lines)


def push_wecom_webhook(url: str, markdown: str) -> bool:
    """把 Markdown 正文经企业微信群机器人 webhook 推送（自动按 4096 字节切片）。

    依赖环境变量 WECOM_WEBHOOK_URL。群机器人 webhook 支持 text/markdown/
    news/image/file，这里用 markdown；单条上限 4096 字节，超限按行切片多头发。
    """
    if not url:
        return False
    chunks: list[str] = []
    cur: list[str] = []
    cur_len = 0
    for ln in markdown.split("\n"):
        b = len(ln.encode("utf-8")) + 1
        if cur_len + b > 4000 and cur:
            chunks.append("\n".join(cur))
            cur = []
            cur_len = 0
        cur.append(ln)
        cur_len += b
    if cur:
        chunks.append("\n".join(cur))
    ok_all = True
    for i, chunk in enumerate(chunks, 1):
        data = json.dumps(
            {"msgtype": "markdown", "markdown": {"content": chunk}},
            ensure_ascii=False,
        ).encode("utf-8")
        req = Request(
            url,
            data=data,
            method="POST",
            headers={"Content-Type": "application/json"},
        )
        try:
            with urlopen(req, timeout=15) as resp:
                txt = resp.read().decode("utf-8", "replace")
                ok = resp.status == 200
                try:
                    obj = json.loads(txt)
                    ok = ok and (obj.get("errcode", -1) == 0)
                except Exception:
                    pass
                print(f"企业微信 webhook 推送 {'成功' if ok else '失败'} (HTTP {resp.status}, 第{i}段/{len(chunks)}段)")
                ok_all = ok_all and ok
        except HTTPError as e:
            print(f"企业微信 webhook 被拒绝 (HTTP {e.code}): {e.read().decode('utf-8','replace')[:200]}")
            ok_all = False
        except URLError as e:
            print(f"企业微信 webhook 失败（网络/地址错误）: {e.reason}")
            ok_all = False
        except Exception as e:  # noqa: BLE001
            print(f"企业微信 webhook 异常: {e}")
            ok_all = False
    return ok_all


def render_wecom_text(payload: dict, signals: list[dict], receipt: dict | None) -> str:
    """纯文本版渲染（wecom-cli 私聊只支持 text，不支持 markdown）。"""
    sel = payload.get("selected", [])
    bm = payload.get("backtest", {}).get("baseMetrics", {})
    ms = payload.get("marketState", {}) or {}
    date = sh_now().strftime("%Y-%m-%d")
    lines: list[str] = []
    lines.append(f"【盘前选股 {date}】")
    state = ms.get("state", "unknown")
    lines.append(f"牛熊判定：{state}（仓位系数 {ms.get('positionFactor', 1.0)}）")
    detail = ms.get("detail", "")
    if detail:
        lines.append(f"  {detail}")
    lines.append("")
    lines.append(f"入选 {payload.get('selectedCount', len(sel))} 只（候选池 {payload.get('universeSize', 0)} 只）")
    if sel:
        for r in sel:
            lines.append(
                f"- {r['code']} {r.get('name','')} 得分 {r.get('score',0):.2f} "
                f"PE {r.get('peTtm')} PB {r.get('pb')} 动量 {r.get('momentum',0)*100:.1f}% RSI {r.get('rsi')}"
            )
    else:
        lines.append("- （今日无入选）")
    lines.append("")
    lines.append(f"基准回测：交易 {bm.get('trades')} 总收益 {bm.get('totalReturn')} 夏普 {bm.get('sharpe')}")
    if signals:
        lines.append("")
        lines.append(f"候选回写（模拟 dry-run） {len(signals)} 笔")
        for s in signals:
            lines.append(f"- BUY {s['code']} {s['name']} @ {s['price']} × {s['quantity']}")
        lines.append("")
        lines.append("回写为模拟：当前 tdx-connector 无 place_order，待接入下单能力券商后切真。")
    if receipt:
        lines.append("")
        lines.append("策略溯源")
        lines.append(f"- 来源：{receipt.get('source')}")
        sha = receipt.get("config_sha256", "")[:8]
        if sha:
            lines.append(f"- 策略SHA：{sha}")
        note = receipt.get("note", "")
        if note:
            lines.append(f"- 备注：{note}")
    return "\n".join(lines)


def find_wecom_cli():
    """定位 wecom-cli 的 node 解释器与入口脚本，返回 (node_exe, wecom_js)；找不到返回 (None, None)。

    wecom-cli 是 node 程序，直接调用其启动器在部分 shell 下会因路径转换出错；
    这里改为直接用 node 运行入口脚本 wecom.js，最稳。
    """
    node = shutil.which("node")
    if not node:
        home = os.path.expanduser("~")
        for cand in (
            os.path.join(home, ".workbuddy", "binaries", "node", "versions", "22.22.2", "node.exe"),
            os.path.join(home, ".workbuddy", "binaries", "node", "versions", "22.22.2", "node"),
        ):
            if os.path.exists(cand):
                node = cand
                break
    cli = shutil.which("wecom-cli")
    candidates: list[str] = []
    if cli:
        base = os.path.dirname(os.path.abspath(cli))
        candidates.append(os.path.join(base, "node_modules", "@wecom", "cli", "bin", "wecom.js"))
    home = os.path.expanduser("~")
    candidates.append(
        os.path.join(home, ".workbuddy", "binaries", "node", "cli-connector-packages",
                     "node_modules", "@wecom", "cli", "bin", "wecom.js")
    )
    for js in candidates:
        if node and os.path.exists(js):
            return node, js
    return None, None


def push_wecom_cli(userid: str, text: str) -> bool:
    """经 wecom-cli 向指定 userid 发送企业微信私聊纯文本（无人值守自动推送）。

    依赖环境变量 WECOM_USERID。注意：
    - wecom-cli 私聊仅支持纯文本（不支持 markdown），故传入纯文本。
    - 单条文本上限约 2048 字节，超限按行切片多头发。
    - 找不到 wecom-cli 时打印提示并返回 False，不中断主流程。
    """
    if not userid:
        return False
    node, js = find_wecom_cli()
    if not node or not js:
        print("（未找到 wecom-cli，跳过企微私聊推送；如需启用请确认企业微信连接器已登录且 node 可用）")
        return False
    # 按 1900 字节切片（预留 JSON 包装余量）
    chunks: list[str] = []
    cur: list[str] = []
    cur_len = 0
    for ln in text.split("\n"):
        b = len(ln.encode("utf-8")) + 1
        if cur_len + b > 1900 and cur:
            chunks.append("\n".join(cur))
            cur = []
            cur_len = 0
        cur.append(ln)
        cur_len += b
    if cur:
        chunks.append("\n".join(cur))
    ok_all = True
    for i, chunk in enumerate(chunks, 1):
        cmd = json.dumps(
            {"chat_type": 1, "chatid": userid, "msgtype": "text", "text": {"content": chunk}},
            ensure_ascii=False,
        )
        try:
            proc = subprocess.run(
                [node, js, "msg", "send_message", cmd],
                capture_output=True, text=True, timeout=30,
            )
            out = (proc.stdout + proc.stderr).strip()
            ok = proc.returncode == 0
            # wecom-cli 以 JSON-RPC 返回：result.isError 或内层 errcode!=0 视为失败
            if ok and out:
                try:
                    obj = json.loads(out)
                    res = obj.get("result", {})
                    if res.get("isError"):
                        ok = False
                    else:
                        inner = (res.get("content") or [{}])[0].get("text", "")
                        try:
                            inner_obj = json.loads(inner)
                            if inner_obj.get("errcode", 0) != 0:
                                ok = False
                        except Exception:
                            pass
                except Exception:
                    pass
            print(f"企业微信私聊推送 {'成功' if ok else '失败'} (返回码 {proc.returncode}, 第{i}段/{len(chunks)}段)")
            if out:
                print(f"  wecom-cli: {out[:400]}")
            ok_all = ok_all and ok
        except subprocess.TimeoutExpired:
            print("企业微信私聊推送超时")
            ok_all = False
        except Exception as e:  # noqa: BLE001
            print(f"企业微信私聊推送异常: {e}")
            ok_all = False
    return ok_all


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prefetched", default=None,
                    help="预取数据文件(prefetched.json)，含 klines/quotes/universe；"
                         "与 --live 二选一（不指定则视为需 --live）")
    ap.add_argument("--out-dir", default=os.path.dirname(os.path.abspath(__file__)))
    ap.add_argument("--overrides", default=None,
                    help="JSON 字符串，含 screener/signal/market/optim 覆盖参数（优先级高于 prefetched.config）")
    ap.add_argument("--profile", default="pre_market",
                    choices=["pre_market", "intraday", "post_market"],
                    help="时段档位：pre_market(盘前) / intraday(盘中) / post_market(盘后)。"
                         "拉取云端配置时只应用该档的条件，避免三时段共用一份全局配置互相干扰。")
    ap.add_argument("--scan-url", default=os.environ.get("CLOUD_SCAN_URL") or "")
    ap.add_argument("--scan-token", default=os.environ.get("CLOUD_SCAN_TOKEN") or "")
    ap.add_argument("--push-url", default=os.environ.get("CLOUD_WRITEBACK_URL") or "")
    ap.add_argument("--push-token", default=os.environ.get("CLOUD_SCAN_TOKEN") or "")
    # —— 云端配置拉取（云端只配不跑，本地拉取后执行）——
    ap.add_argument("--cloud-config-url",
                    default=os.environ.get("CLOUD_BASE_URL")
                            or os.environ.get("CLOUD_CFG_URL")
                            or os.environ.get("CLOUD_SCAN_URL", "").replace("/api/strategy-scan", "").rstrip("/"),
                    help="云端基地址，如 http://<服务器IP>:9003；提供则启动时先拉取云端配置作为 overrides")
    ap.add_argument("--cloud-user", default=os.environ.get("CLOUD_CFG_USER") or "")
    ap.add_argument("--cloud-pass", default=os.environ.get("CLOUD_CFG_PASS") or "")
    # —— 全市场实时扫描模式（候选池由中枢经 tdx_screener 构建，K线/行情走实时数据源）——
    ap.add_argument("--live", action="store_true",
                    help="实时数据模式：仅从 --universe-file 读取候选代码，"
                         "K线/行情由引擎实时数据源(腾讯/东财直连)获取；"
                         "用于「按云端板块全市场选股」。配合 --universe-file 使用。")
    ap.add_argument("--universe-file", default=None,
                    help="与 --live 配合：JSON 文件，含 {\"universe\": [code,...]}")
    args = ap.parse_args()

    if args.live:
        # 全市场实时扫描：候选池来自中枢经 tdx_screener 构建的 universe 文件，
        # K线/行情由引擎实时数据源(腾讯/东财直连)获取；云端板块/市值/PE/PB 已在
        # tdx_screener 查询与下方 screener 硬性过滤中双重生效。
        if not args.universe_file:
            print("--live 需要配合 --universe-file")
            sys.exit(1)
        try:
            with open(args.universe_file, encoding="utf-8") as _f:
                _udata = json.load(_f)
        except Exception as e:  # noqa: BLE001
            print(f"读取 universe-file 失败: {e}")
            sys.exit(1)
        codes = [str(c).strip() for c in _udata.get("universe", []) if str(c).strip()]
        klines = quotes = None
        hot = []
        prefetched_cfg = {}
        data_fetcher = None  # 实时数据源（腾讯/东财直连）
        if not codes:
            print("universe-file 中没有可用标的，退出。")
            sys.exit(1)
        print(f"[LIVE 全市场模式] 候选池来自 {args.universe_file}：{len(codes)} 只（实时行情）")
    else:
        if not args.prefetched:
            print("未指定 --prefetched 也未启用 --live，退出。")
            sys.exit(1)
        klines, quotes, hot, codes, prefetched_cfg = load_prefetched(args.prefetched)
        if not codes:
            print("prefetched.json 中没有可用标的，退出。")
            sys.exit(1)

        def data_fetcher():
            return klines, quotes, hot

    # CLI overrides（用户显式意图，优先级最高）
    cli_ov: dict = {}
    if args.overrides:
        try:
            parsed = json.loads(args.overrides)
            if isinstance(parsed, dict):
                cli_ov = parsed
                print(f"已解析 CLI overrides: {list(cli_ov.keys())}")
        except json.JSONDecodeError as e:
            print(f"--overrides JSON 解析失败: {e}，忽略")

    profile = getattr(args, "profile", None) or "pre_market"

    # 云端配置拉取（按 profile 取对应档，云端只配不跑，本地拉取后执行）：
    # 优先级介于 strategy_config.yaml 与 prefetched/CLI 之间，
    # 即「云端条件可用，本地 prefetched/CLI 仍可覆盖」。
    cloud_receipt = None
    cloud_cookie = None
    cloud_ov: dict = {}
    if args.cloud_config_url:
        cloud_ov, cloud_cookie, cloud_receipt = pull_cloud_overrides(
            args.cloud_config_url, args.cloud_user, args.cloud_pass, profile)
        if cloud_ov:
            print(f"已套用云端配置(profile={profile}, {args.cloud_config_url}): {list(cloud_ov.keys())}")
        else:
            print(f"[云端配置] 来源={cloud_receipt['source']} | {cloud_receipt.get('note','')}")

    # 解析策略预设：云端 profile 配置 + CLI 显式覆盖共同决定基线；
    # preset 作为「配方基线」，显式字段（云端 profile / CLI）覆盖预设。
    # 优先级（低->高）：云端 profile 配置 < CLI 显式覆盖；preset 基线被显式字段覆盖。
    eff = {**cloud_ov, **cli_ov}
    merged = presets.resolve_preset(eff)
    if eff.get("preset"):
        print(f"已套用策略预设: {eff.get('preset')} (profile={profile})")
    # 最终优先级（低->高）：prefetched 内嵌 config < 预设基线 < 云端 profile 显式字段 < CLI 显式覆盖
    # （云端 profile / CLI 的显式字段会覆盖预设基线中同名项；预设只填补未显式指定的字段）
    ov = {**prefetched_cfg, **merged}

    cfg = config.AppConfig()
    cfg.universe = codes
    # 持久默认：strategy_config.yaml（优先级低于 prefetched/云端/CLI）
    yaml_ov = config.load_strategy_config()
    if yaml_ov:
        apply_config(cfg, yaml_ov)
        print(f"已套用 strategy_config.yaml: {list(yaml_ov.keys())}")

    if cloud_ov:
        apply_config(cfg, cloud_ov)
    if cloud_receipt is None:
        cloud_receipt = {
            "source": "local-fallback",
            "base_url": args.cloud_config_url or "",
            "endpoint": "/api/strategy-scan/config",
            "fetched_at": sh_now_aware().strftime("%Y-%m-%d %H:%M:%S %z"),
            "http_status": None,
            "login_ok": False,
            "config_sha256": "",
            "config_keys": [],
            "note": "未提供云端基地址（--cloud-config-url 为空），未从云端拉取策略，使用本地默认/配置",
        }
    _write_cloud_receipt(cloud_receipt, args.out_dir)

    apply_config(cfg, ov)

    # 防止宽基指数代码混入选股候选池：
    # 中枢会把指数 K 线注入 klines["index_code"]，若 universe 由 klines 键推导则会包含它。
    _idx = (cfg.market.index_code or "").strip()
    if _idx and _idx in cfg.universe:
        cfg.universe = [c for c in cfg.universe if c != _idx]

    # 纯引擎运行（回写/推送由枢纽负责，这里不传）
    # data_fetcher: live 模式为 None（走引擎实时数据源），否则为返回预取数据的函数。
    payload = hub_run(cfg, data_fetcher=data_fetcher)
    if args.live:
        # 实时模式：用实时数据源取入选标的的最新收盘价作委托价
        _dp = default_provider()
        _sel = [r["code"] for r in payload.get("selected", [])]
        _kl = {c: _dp.fetch_kline(c, cfg.beg, cfg.end) for c in _sel}
        signals = _build_signals(payload, _kl)
    else:
        signals = _build_signals(payload, klines)

    # 记录本次扫描所属时段档位（盘前/盘中/盘后），便于前端结果区标注来源，
    # 也随 scan_payload.json 推送云端后在「文件桥接」展示时保留档位信息。
    payload["profile"] = profile

    out_dir = args.out_dir
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, "scan_payload.json"), "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2, default=str)
    with open(os.path.join(out_dir, "signals_out.json"), "w", encoding="utf-8") as f:
        json.dump(signals, f, ensure_ascii=False, indent=2, default=str)

    # P2: 输出轻量摘要/策略快照，供中枢报告步骤读取，避免整读 49KB scan_payload 与二次拉云端配置
    _write_scan_summary(payload, profile, out_dir)
    _write_strategy_snapshot(cfg, cloud_receipt, profile, out_dir)

    sel = payload.get("selected", [])
    bm = payload.get("backtest", {}).get("baseMetrics", {})
    print("=== trading_agent 引擎运行完成（纯计算，回写/推送由枢纽执行）===")
    print(f"候选池: {payload.get('universeSize')} 只 | 入选: {payload.get('selectedCount')} 只")
    for r in sel:
        print(
            f"  {r['code']} {r.get('name','')}  得分={r.get('score',0):.3f}  "
            f"PE={r.get('peTtm')}  PB={r.get('pb')}  动量={r.get('momentum',0)*100:.1f}%"
        )
    print(f"\n基准回测: 交易={bm.get('trades')} 总收益={bm.get('totalReturn')} 夏普={bm.get('sharpe')}")
    print(f"\n候选回写信号: {len(signals)} 笔")
    for s in signals:
        print(f"  BUY {s['code']} {s['name']} @ {s['price']} x{s['quantity']}")
    print(f"\n已写出: scan_payload.json, signals_out.json")

    # 可选：把扫描结果推送到云端「策略扫描」页
    if args.scan_url and args.scan_token:
        # 复用云端配置拉取时建立的登录会话，使结果按登录用户隔离（user_id=本人）。
        push_scan(args.scan_url, args.scan_token, payload, cookie=cloud_cookie)
    else:
        print("（未配置扫描推送地址/令牌，跳过云端扫描推送；本地 scan_payload.json 已就绪）")

    # 可选：把候选回写信号推送到云端「回写结果」页
    if args.push_url and args.push_token:
        # 复用云端配置拉取时建立的登录会话，使回写结果按登录用户隔离（user_id=本人）。
        push_writeback(args.push_url, args.push_token, build_writeback_payload(signals), cookie=cloud_cookie)
    else:
        print("（未配置回写推送地址/令牌，跳过云端回写推送；本地 signals_out.json 已就绪）")

    # 可选：把选股结果推送到个人微信（经 Server酱 / PushPlus 中转，落点=微信「服务通知」）
    if (os.environ.get("WX_PUSH_DRIVER") or "").lower() not in ("", "none"):
        push_wechat(payload, signals)
    else:
        print("（未配置 WX_PUSH_DRIVER，跳过微信推送；如需微信接收，在 .env 设置 WX_PUSH_DRIVER + 对应 Key）")

    # 可选：把选股结果推送到企业微信
    # 双推：WECOM_USERID 私聊（落点=本人企微）+ WECOM_WEBHOOK_URL 群机器人（落点=群），两者互不阻塞
    wecom_userid = os.environ.get("WECOM_USERID") or ""
    wecom_url = os.environ.get("WECOM_WEBHOOK_URL") or ""
    if wecom_userid or wecom_url:
        if wecom_userid:
            _wecom_txt = render_wecom_text(payload, signals, cloud_receipt)
            push_wecom_cli(wecom_userid, _wecom_txt)
        if wecom_url:
            _wecom_md = render_wecom_markdown(payload, signals, cloud_receipt)
            push_wecom_webhook(wecom_url, _wecom_md)
    else:
        print("（未配置企业微信推送：WECOM_USERID / WECOM_WEBHOOK_URL 均未设置，跳过企微推送）")


if __name__ == "__main__":
    main()
