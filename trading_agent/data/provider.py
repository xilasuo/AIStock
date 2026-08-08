"""数据底座 · 真实 A 股数据获取（对应架构「数据底座·连接器」）

数据源（均免 key、HTTP 直连，已实测可用）：
  - 腾讯财经 API   → 实时估值（PE/PB/市值/换手率等），不封 IP
  - 东财 push2his  → 前复权日线 K 线（OHLCV）；**本机常被限流，见下方熔断说明**
  - 新浪 / 腾讯 ifzq → K 线兜底源，实测稳定

内置本地缓存（cache/），避免重复打网络；内置同域令牌节流。

**取数性能（2026-08-08 优化）**
批量跑批（600 只候选池）实测 776s，逐项定位后做了三处改动：
  1. 东财熔断：东财失效时每只票要在 3 次重试+退避上白等约 3.5s，而新浪/腾讯
     仅需 0.25~0.35s。现改为「连续失败 _EM_MAX_FAIL 次即本进程内停用东财」，
     且东财探测只重试 1 次——前两只票快速探路，其余直接走兜底源。
  2. 节流修正：原 `_last_call` 是模块级无锁标量，多线程下读改写竞争，节流语义
     形同虚设、并发反被压成批次。现改为**按域名**的令牌预约（锁内定时刻、锁外
     sleep），既真正限速又不串行化。
  3. 缓存 key 保持含 beg（K 线必须每日重取以纳入最新交易日，TTL 86400 即为此
     设计），但清理陈旧 beg 分桶避免磁盘无限堆积。
"""
from __future__ import annotations

import json
import os
import threading
import time
from datetime import timedelta
import urllib.parse
import urllib.request
from abc import ABC, abstractmethod
from typing import Optional

import config
from data import fundamentals
from timeutil import sh_now

_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/117.0.0.0 Safari/537.36"
_CACHE_DIR = config.CACHE_DIR
_THROTTLE = 0.03  # 同一域名两次请求的最小间隔（秒），约 33 req/s/域名
_last_call: dict[str, float] = {}
_throttle_lock = threading.Lock()


def _throttle(host: str = ""):
    """同域令牌预约限速（线程安全）。

    原实现用模块级标量 `_last_call[0]` 且无锁：8 个 worker 线程同时读到相同
    时间戳、算出相同 wait、一起 sleep 再一起发包，节流没起到限速作用，反而把
    并发压成「一批一批」。这里改为按域名预约下一个可发时刻——锁内只做时刻
    计算与登记（O(1)，不 sleep），锁外再 sleep，多线程下自然排成公平队列。
    """
    with _throttle_lock:
        now = time.time()
        nxt = max(now, _last_call.get(host, 0.0) + _THROTTLE)
        _last_call[host] = nxt
        wait = nxt - now
    if wait > 0:
        time.sleep(wait)


def _http_get(url: str, params: Optional[dict] = None, timeout: int = 12,
              retries: int = 3) -> str:
    """HTTP GET（同域节流 + 有限重试）。

    retries=1 表示「快速失败」，用于**存在下游兜底源**的探测型请求（如东财
    K 线）：失败时立刻让位给新浪/腾讯，而不是在退避上白白耗掉数秒。
    """
    if params:
        url = url + "?" + urllib.parse.urlencode(params)
    host = urllib.parse.urlsplit(url).hostname or ""
    req = urllib.request.Request(url)
    req.add_header("User-Agent", _UA)
    last_err = None
    for attempt in range(max(1, retries)):
        try:
            _throttle(host)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                charset = r.headers.get_content_charset() or "utf-8"
                return r.read().decode(charset, errors="replace")
        except Exception as e:  # 瞬时网络错误重试（连接被断开/超时等）
            last_err = e
            if attempt < retries - 1:  # 最后一次失败不再退避，直接抛给兜底源
                time.sleep(0.5 * (attempt + 1))
    raise last_err


# ---- 东财源熔断（批量跑批时避免逐票重复白等）----------------------------
# 三态：UNKNOWN 未知 -> 仅放一个「探路者」去试，其余线程先走兜底源，避免 N 个
#       worker 同时撞一个已失效的服务（实测 16 线程会并发白等 16 次）；
#       HEALTHY 健康 -> 全线程正常并发走东财；DEAD 已停用 -> 直接跳过。
_EM_UNKNOWN, _EM_HEALTHY, _EM_DEAD = 0, 1, 2
_EM_MAX_FAIL = 2       # 连续失败达到此数 -> 本进程内判定 DEAD
_em_state = [_EM_UNKNOWN]
_em_fail = [0]
_em_lock = threading.Lock()
_em_probe = threading.Lock()


def _em_should_try() -> tuple[bool, bool]:
    """是否尝试东财。返回 (要不要试, 是否持有探测锁)。"""
    st = _em_state[0]
    if st == _EM_DEAD:
        return False, False
    if st == _EM_HEALTHY:
        return True, False
    if _em_probe.acquire(blocking=False):  # UNKNOWN：只放一个探路者
        return True, True
    return False, False


def _em_mark(ok: bool, probing: bool = False):
    """登记一次东财调用结果并推进状态机。"""
    try:
        with _em_lock:
            if ok:
                _em_fail[0] = 0
                _em_state[0] = _EM_HEALTHY
            else:
                _em_fail[0] += 1
                if _em_fail[0] >= _EM_MAX_FAIL:
                    _em_state[0] = _EM_DEAD
    finally:
        if probing:
            _em_probe.release()


def _em_available() -> bool:
    """东财是否未被判定失效（供外部只读探查/测试断言）。"""
    return _em_state[0] != _EM_DEAD


def reset_source_health():
    """重置源熔断状态（供测试/长驻进程跨批次复位）。"""
    with _em_lock:
        _em_fail[0] = 0
        _em_state[0] = _EM_UNKNOWN


def _cache_path(kind: str, key: str) -> str:
    os.makedirs(_CACHE_DIR, exist_ok=True)
    return os.path.join(_CACHE_DIR, f"{kind}_{key}.json")


def _load_cache(kind: str, key: str, max_age_sec: int = 86400) -> Optional[dict]:
    p = _cache_path(kind, key)
    if not os.path.exists(p):
        return None
    if (time.time() - os.path.getmtime(p)) > max_age_sec:
        return None
    try:
        with open(p, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def _save_cache(kind: str, key: str, data: dict):
    p = _cache_path(kind, key)
    with open(p, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)


def purge_stale_kline_cache(keep_beg: Optional[str] = None) -> int:
    """清理 K 线缓存中非当前起始日的历史分桶，返回删除个数。

    K 线缓存文件名形如 `kline_{code}_{beg}_{end}.json`，而 beg = 今天-620 天，
    **每天换一个桶**。旧桶永远不会再被命中，却会一直堆在磁盘上（实测累积到
    4213 个文件 / 237MB）。注意：K 线必须每日重取以纳入最新交易日，因此「每天
    换桶」本身是正确的，问题只在旧桶从不回收。跑批前调用一次，即可把缓存体积
    稳定在「候选池规模 × 1 份」。
    """
    if keep_beg is None:
        keep_beg = (sh_now().date() - timedelta(days=620)).strftime("%Y%m%d")
    token = f"_{keep_beg}_"
    n = 0
    try:
        for fn in os.listdir(_CACHE_DIR):
            if fn.startswith("kline_") and fn.endswith(".json") and token not in fn:
                try:
                    os.remove(os.path.join(_CACHE_DIR, fn))
                    n += 1
                except OSError:
                    pass
    except OSError:
        pass
    return n


def market_prefix(code: str) -> str:
    if code.startswith(("6", "9")):
        return "sh"
    if code.startswith("8"):
        return "bj"
    return "sz"


def _index_route(code: str):
    """指数代码路由（相对个股前缀不同）。

    注意冲突：沪市「主板个股」也以 000 开头（如 000001 平安银行），不能整段判指数。
    安全规则：
      - 880/999 段：沪市指数/板块专用，不与个股冲突 -> sh / 1.
      - 399 段：深市指数专用，不与个股冲突 -> sz / 0.
      - 000 段：仅放行「纯指数、无对应个股」的代码（排除 000001 等个股冲突码）。
    返回 (sina_prefix, emarket) 或 None（非指数，走个股逻辑）。
    """
    if code.startswith(("880", "999")):
        return "sh", "1."
    if code.startswith("399"):
        return "sz", "0."
    # 000 段需白名单，避免误伤深市主板个股（000001=平安银行等）。
    _PURE_INDEX_000 = {
        "000016",  # 上证50
        "000300",  # 沪深300
        "000688",  # 科创50
        "000905",  # 中证500
        "000010",  # 上证180
        "000009",  # 上证380
        "000013",  # 上证180等权
    }
    if code in _PURE_INDEX_000:
        return "sh", "1."
    return None


def _sina_kline(code: str) -> list[dict]:
    """新浪日 K 线（免 key、稳定）。scale=240 为日线。返回原始记录列表。"""
    route = _index_route(code)
    prefix = route[0] if route else (
        "sh" if code.startswith(("6", "9")) else ("bj" if code.startswith("8") else "sz")
    )
    url = "https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData"
    params = {"symbol": f"{prefix}{code}", "scale": "240", "ma": "no", "datalen": "400"}
    d = json.loads(_http_get(url, params))
    return d or []


def _em_kline(code: str, beg: str, end: str) -> list[dict]:
    """东财 push2his 日 K 线（兜底源，前复权）。"""
    route = _index_route(code)
    secid = (route[1] if route else ("1." if code.startswith("6") else "0.")) + code
    url = "https://push2his.eastmoney.com/api/qt/stock/kline/get"
    params = {
        "secid": secid,
        "fields1": "f1,f2,f3,f4,f5,f6",
        "fields2": "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
        "klt": "101", "fqt": "1", "beg": beg, "end": end,
    }
    # retries=1：东财失败时下游有新浪/腾讯兜底，快速失败比退避重试更划算。
    d = json.loads(_http_get(url, params, retries=1))
    rows = []
    for line in (d.get("data") or {}).get("klines") or []:
        p = line.split(",")
        if len(p) < 11:
            continue
        rows.append({
            "date": p[0], "open": float(p[1]), "close": float(p[2]),
            "high": float(p[3]), "low": float(p[4]), "vol": float(p[5]),
            "amplitude": float(p[7]),
            "pct": float(p[8]), "turnover": float(p[10]) if p[10] not in ("", "-") else 0.0,
        })
    return rows


def _tencent_qfq_kline(code: str, beg: str | None, end: str) -> list[dict]:
    """腾讯 前复权日 K 线（westock 同后端）。域名双备：
    主用 proxy.finance.qq.com（2026-08-08 起：web.ifzq.gtimg.cn 被腾讯 WAF
    拦截返回 501，proxy 域名实测可用且 qfqday 口径与 ifzq 完全一致）；
    备用 web.ifzq.gtimg.cn（原主域名，WAF 解除后自动恢复，无需改码）。
    与 eastmoney/新浪是**不同域名**，不受其限流影响；作为 fetch_kline 的
    第二兜底源，专治「东财失效 → 静默吃新浪未复权」的复权口径问题。
    返回归一化 bars；所有域名失败返回 []（交给上层决定缓存与否）。
    """
    route = _index_route(code)
    sym = (route[0] if route else (
        "sh" if code.startswith(("6", "9")) else ("bj" if code.startswith("8") else "sz")
    )) + code
    # 顺序即优先级：proxy 为主（当前可用），ifzq 为备（WAF 解除后生效）
    bases = (
        "https://proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get",
        "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get",
    )
    for base in bases:
        url = f"{base}?param={sym},day,,,400,qfq"
        try:
            d = json.loads(_http_get(url, retries=1))
        except Exception:
            continue
        node = (d.get("data") or {}).get(sym) or {}
        # 个股前复权在 qfqday；指数无复权节点用 day
        rows = node.get("qfqday") or node.get("day") or []
        if not rows:
            continue
        out = []
        for p in rows:
            try:
                # 格式 [date, open, close, high, low, volume(手)]
                out.append({
                    "date": p[0],
                    "open": float(p[1]), "close": float(p[2]),
                    "high": float(p[3]), "low": float(p[4]),
                    "vol": float(p[5]) * 100,   # 手 -> 股，与东财对齐
                    "amplitude": 0.0, "pct": 0.0, "turnover": 0.0,
                })
            except Exception:
                continue
        if out:
            return out
    return []


def _normalize_kline(raw: list[dict]) -> list[dict]:
    """统一字段 -> {date, open, close, high, low, vol, amount, ...}"""
    out = []
    for b in raw:
        if "day" in b:  # 新浪格式
            out.append({
                "date": b["day"], "open": float(b["open"]), "close": float(b["close"]),
                "high": float(b["high"]), "low": float(b["low"]),
                "vol": float(b.get("volume", 0)),
                "amplitude": 0.0, "pct": 0.0, "turnover": 0.0,
            })
        else:  # 东财格式
            out.append(b)
    return out


def fetch_kline(code: str, beg: str | None = None, end: str = "20500101") -> list[dict]:
    """获取日线 K 线（东财前复权为主，新浪/腾讯 ifzq 兜底）。

    返回: [{date, open, close, high, low, vol, amount, ...}, ...]（按日期升序）

    **复权一致性（重要，2026-08-08 修正源顺序）**
    统一以**前复权**口径为准，避免除权除息日的信号/回测失真。兜底顺序按「口径
    一致性」而非「历史习惯」排列：
        东财 fqt=1(前复权) -> 腾讯 ifzq qfq(前复权) -> 新浪(未复权，最后兜底)
    原顺序把**未复权**的新浪排在腾讯之前，在东财失效的当下会让整条链路悄悄吃到
    未复权数据：实测 600519 近 400 根有 369 根与前复权不一致，差值随分红呈阶梯
    （+103.46 -> +28.02），会在除权日制造虚假跳空、污染动量/趋势因子与回测收益。
    新浪仅在两个前复权源都失败时启用，属「有数据总比没有强」的最后手段。

    **防缓存毒化（关键修复 2026-08-08）**
    三源全失败时返回 [] 且**绝不落盘**——否则空结果会被写进缓存（TTL 86400s），
    后续重跑秒回 0 根、伪装成「无数据」，实为毒化缓存。异常只应重试源，不该污染缓存。
    """
    if beg is None:
        beg = (sh_now().date() - timedelta(days=620)).strftime("%Y%m%d")
    cached = _load_cache("kline", f"{code}_{beg}_{end}")
    if cached is not None:
        return cached

    rows: list[dict] = []
    # 东财熔断：跑批时东财一旦被限流，600 只票会各白等一次重试+退避。这里最多
    # 由 _EM_MAX_FAIL 个「探路者」串行试错，确认失效后其余全部直接走兜底源。
    _try_em, _probing = _em_should_try()
    if _try_em:
        try:
            rows = _em_kline(code, beg, end)
            _em_mark(bool(rows), _probing)
        except Exception:
            _em_mark(False, _probing)
            rows = []
    if not rows:  # 兜底1 腾讯 ifzq：前复权，与东财口径一致，独立域名不受其限流影响
        try:
            rows = _tencent_qfq_kline(code, beg, end)
        except Exception:
            rows = []
    if not rows:  # 兜底2 新浪：**未复权**，口径不一致，仅在前两个源全灭时启用
        try:
            rows = _normalize_kline(_sina_kline(code))
        except Exception:
            rows = []

    # 仅在有数据时落盘；空结果不缓存（防毒化）
    if rows:
        _save_cache("kline", f"{code}_{beg}_{end}", rows)
    return rows


def fetch_quote(code: str) -> dict:
    """获取实时估值（腾讯财经 API）。

    返回: {name, price, pe_ttm, pb, mcap_yi, float_mcap_yi, turnover_pct, change_pct, ...}
    """
    cached = _load_cache("quote", code)
    if cached is not None:
        return cached

    prefix = market_prefix(code)
    url = f"https://qt.gtimg.cn/q={prefix}{code}"
    data = _http_get(url)
    # 形如 v_sh600519="...";
    if '"' not in data:
        return {}
    vals = data.split('"')[1].split("~")
    if len(vals) < 53:
        return {}
    q = {
        "code": code,
        "name": vals[1],
        "price": float(vals[3] or 0),
        "last_close": float(vals[4] or 0),
        "open": float(vals[5] or 0),
        "change_pct": float(vals[32] or 0),
        "high": float(vals[33] or 0),
        "low": float(vals[34] or 0),
        "amount_wan": float(vals[37] or 0),
        "turnover_pct": float(vals[38] or 0),
        "pe_ttm": float(vals[39] or 0),
        "amplitude_pct": float(vals[43] or 0),
        "mcap_yi": float(vals[44] or 0),
        "float_mcap_yi": float(vals[45] or 0),
        "pb": float(vals[46] or 0),
        "limit_up": float(vals[47] or 0),
        "limit_down": float(vals[48] or 0),
        "pe_static": float(vals[52] or 0),
    }
    # 仅在有数据时落盘；空结果不缓存（防毒化：避免空 quote 被缓存后伪装成「无数据」）
    if q:
        _save_cache("quote", code, q)
    return q


def _eastmoney_secid(code: str) -> str:
    """东财 secid：沪市 1.xxx，深市/创业板/北交所 0.xxx。"""
    if code.startswith(("6", "9")):
        return "1." + code
    return "0." + code


def fetch_fund_flow(code: str) -> float | None:
    """个股主力资金净流入（元），来自东财公开接口（等效 AKShare stock_individual_fund_flow）。

    返回最近一日主力净流入额（元）；接口失败/数据缺失返回 None（调用方据此降级资金流因子）。
    """
    cached = _load_cache("fflow", code, max_age_sec=3600)  # 资金流变化快，缓存 1 小时
    if cached is not None:
        return cached.get("main_net_inflow")
    try:
        secid = _eastmoney_secid(code)
        url = "https://push2.eastmoney.com/api/qt/stock/fflow/daykline/get"
        params = {
            "lmt": "1", "klt": "101", "secid": secid,
            "fields1": "f1,f2,f3,f7",
            "fields2": "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64,f65",
        }
        # 短超时：该接口在部分网络环境不稳定，避免逐股长时间挂起拖累整体取数。
        d = json.loads(_http_get(url, params, timeout=4))
        klines = (d.get("data") or {}).get("klines") or []
        if not klines:
            _save_cache("fflow", code, {"main_net_inflow": None})  # 负缓存，避免重复挂起
            return None
        cells = klines[-1].split(",")
        # fields2 索引：f51=日期, f52=主力净流入额(元), f53=小单净流入 ...
        if len(cells) < 2:
            _save_cache("fflow", code, {"main_net_inflow": None})
            return None
        val = float(cells[1] or 0)
        _save_cache("fflow", code, {"main_net_inflow": val})
        return val
    except Exception:
        # 失败也缓存（负缓存），同一进程/短时重跑不再重复挂起。
        _save_cache("fflow", code, {"main_net_inflow": None})
        return None


def fetch_hot_stocks() -> list[dict]:
    """同花顺当日强势股（题材归因），作候选池时调用。零鉴权。"""
    cached = _load_cache("hot", "today")
    if cached is not None:
        return cached
    today = sh_now().strftime("%Y-%m-%d")
    url = (
        f"http://zx.10jqka.com.cn/event/api/getharden/"
        f"date/{today}/orderby/date/orderway/desc/charset/GBK/"
    )
    try:
        d = json.loads(_http_get(url))
    except Exception:
        return []
    rows = []
    for it in (d.get("data") or []):
        rows.append({
            "code": str(it.get("code", "")),
            "name": it.get("name", ""),
            "reason": it.get("reason", ""),
            "change_pct": float(it.get("zhangfu") or 0),
        })
    _save_cache("hot", "today", rows)
    return rows


class DataProvider(ABC):
    """数据源抽象（架构图「数据底座·连接器」的统一接口）。

    trading_agent 引擎只认这个接口，不关心数据来自腾讯/东财直连、
    还是来自 WorkBuddy 中枢（westock-mcp / tdx-connector）。
    这让「WorkBuddy 当中枢」成为可能：中枢取数后注入 StaticProvider，
    引擎照常计算，自身不直连任何 MCP。
    """

    @abstractmethod
    def fetch_kline(self, code: str, beg: str, end: str) -> list[dict]: ...

    @abstractmethod
    def fetch_quote(self, code: str) -> dict: ...

    @abstractmethod
    def fetch_hot_stocks(self) -> list[dict]: ...

    @abstractmethod
    def fetch_fundamentals(self, code: str) -> dict: ...


class TencentEastMoneyProvider(DataProvider):
    """默认数据源：腾讯估值 + 东财/新浪 K 线，免 key 直连。"""

    def fetch_kline(self, code: str, beg: str, end: str) -> list[dict]:
        return fetch_kline(code, beg, end)

    def fetch_quote(self, code: str) -> dict:
        q = fetch_quote(code)
        # 接入基本面数据源：把 ROE / 股息率 合并进 quote，质量因子自动启用
        try:
            f = fundamentals.fetch_fundamentals(code)
            if f.get("roe") is not None:
                q["roe"] = f["roe"]
            if f.get("dividend_yield") is not None:
                q["dividend_yield"] = f["dividend_yield"]
        except Exception:
            pass
        # 接入主力资金流：合并进 quote，资金流因子据此启用（接口失败则缺省，权重自动归零）
        ff = fetch_fund_flow(code)
        if ff is not None:
            q["fund_flow"] = ff
        return q

    def fetch_hot_stocks(self) -> list[dict]:
        return fetch_hot_stocks()

    def fetch_fundamentals(self, code: str) -> dict:
        return fundamentals.fetch_fundamentals(code)


class StaticProvider(DataProvider):
    """WorkBuddy 中枢注入的预取数据（来自 westock/tdx 连接器）。

    中枢先把 connectors 取到的 K 线/估值/热点放进这里，再交给引擎——
    引擎完全不知道数据来源，实现中枢与引擎解耦。
    """

    def __init__(
        self,
        klines: Optional[dict[str, list[dict]]] = None,
        quotes: Optional[dict[str, dict]] = None,
        hot: Optional[list[dict]] = None,
        fundamentals: Optional[dict[str, dict]] = None,
    ):
        self._klines = klines or {}
        self._quotes = quotes or {}
        self._hot = hot if hot is not None else []
        self._fundamentals = fundamentals or {}

    def fetch_kline(self, code: str, beg: str, end: str) -> list[dict]:
        return list(self._klines.get(code, []))

    def fetch_quote(self, code: str) -> dict:
        q = dict(self._quotes.get(code, {}))
        # 合并注入的基本面（ROE / 股息率），质量因子据此启用
        f = self._fundamentals.get(code) or {}
        if f.get("roe") is not None:
            q["roe"] = f["roe"]
        if f.get("dividend_yield") is not None:
            q["dividend_yield"] = f["dividend_yield"]
        # 透传中枢注入的主力资金流（fund_flow 字段在 quotes[code] 或 fundamentals 里均可）
        if q.get("fund_flow") is None and f.get("fund_flow") is not None:
            q["fund_flow"] = f["fund_flow"]
        return q

    def fetch_hot_stocks(self) -> list[dict]:
        return list(self._hot)

    def fetch_fundamentals(self, code: str) -> dict:
        f = self._fundamentals.get(code) or {}
        return {
            "roe": f.get("roe"),
            "dividend_yield": f.get("dividend_yield"),
        }


class GatewayProvider(DataProvider):
    """通过 HTTP 网关取数（网关由 WorkBuddy 中枢托管，转发到连接器）。

    适用于：trading_agent 以独立进程/定时任务运行，但仍希望数据走
    WorkBuddy 中枢的连接器。网关地址由 WORKBUDDY_GATEWAY_URL 配置。
    """

    def __init__(self, gateway_url: str, timeout: int = 15):
        self.gateway_url = gateway_url.rstrip("/")
        self.timeout = timeout

    def _get(self, path: str, params: dict) -> dict:
        qs = urllib.parse.urlencode(params)
        req = urllib.request.Request(f"{self.gateway_url}{path}?{qs}")
        with urllib.request.urlopen(req, timeout=self.timeout) as r:
            return json.loads(r.read().decode("utf-8", "replace"))

    def fetch_kline(self, code: str, beg: str, end: str) -> list[dict]:
        return self._get("/kline", {"code": code, "beg": beg, "end": end}).get("bars", [])

    def fetch_quote(self, code: str) -> dict:
        return self._get("/quote", {"code": code}).get("quote", {})

    def fetch_hot_stocks(self) -> list[dict]:
        return self._get("/hot", {}).get("stocks", [])


class HubBackedProvider(DataProvider):
    """经 WorkBuddy 中枢连接器（westock/tdx MCP）取数，失败回退直连。

    设计意图落地：trading_agent 作为纯计算引擎，数据优先来自 WorkBuddy 已连接的
    westock-mcp / tdx-connector；任一连接器不可用或解析失败时，自动回退到
    腾讯/东财直连（TencentEastMoneyProvider），保证零配置也能跑。

    ⚠️ 安全网：westock/tdx 返回空或缺少价格等必要字段时，request_quote/kline
    会回退直连，绝不把错误或残缺数据喂给引擎。
    """

    def __init__(self, hub):
        self._hub = hub

    def fetch_kline(self, code: str, beg: str, end: str) -> list[dict]:
        return self._hub.request_kline(code, beg, end)

    def fetch_quote(self, code: str) -> dict:
        q = self._hub.request_quote(code) or {}
        if not q:  # 连接器未取到，回退直连
            q = fetch_quote(code)
        # 与 TencentEastMoneyProvider 一致：合并基本面 + 主力资金流，质量/资金因子据此启用
        try:
            f = fundamentals.fetch_fundamentals(code)
            if f.get("roe") is not None:
                q["roe"] = f["roe"]
            if f.get("dividend_yield") is not None:
                q["dividend_yield"] = f["dividend_yield"]
        except Exception:
            pass
        ff = fetch_fund_flow(code)
        if ff is not None:
            q["fund_flow"] = ff
        return q

    def fetch_hot_stocks(self) -> list[dict]:
        return fetch_hot_stocks()

    def fetch_fundamentals(self, code: str) -> dict:
        return fundamentals.fetch_fundamentals(code)


def default_provider() -> DataProvider:
    """按配置返回数据源（中枢优先，直连兜底）：

    1) 配了 WORKBUDDY_GATEWAY_URL  → GatewayProvider（中枢网关托管）
    2) 配了 westock/tdx 端点       → HubBackedProvider（直连中枢 MCP 连接器，失败回退直连）
    3) 都没配                      → TencentEastMoneyProvider（腾讯/东财直连，零配置可用）
    """
    gw = os.environ.get("WORKBUDDY_GATEWAY_URL", "").strip()
    if gw:
        return GatewayProvider(gw)
    try:
        import config as _cfg
        from bridge import ConnectorHub
        # 实时读 env：config 的模块级常量在 import 期固化，若 .env 晚于 config 导入加载会失效，
        # 这里直接读 os.environ，确保 run_hub 自动加载 .env 后 MCP 端点能即时生效。
        wu = os.environ.get("WESTOCK_MCP_URL", "").strip() or _cfg.WESTOCK_MCP_URL
        wt = os.environ.get("WESTOCK_MCP_TOKEN", "").strip() or _cfg.WESTOCK_MCP_TOKEN
        tu = os.environ.get("TDX_MCP_URL", "").strip() or _cfg.TDX_MCP_URL
        ta = os.environ.get("TDX_API_KEY", "").strip() or _cfg.TDX_API_KEY
        if (wu or tu) and (wt or ta or wu):
            cc = _cfg.ConnectorsConfig(
                westock_url=wu, westock_token=wt, tdx_url=tu, tdx_api_key=ta
            )
            hub = ConnectorHub(_cfg.AppConfig(connectors=cc))
            return HubBackedProvider(hub)
    except Exception:
        # 连接器导入/构建失败（如依赖缺失），安全回退直连
        pass
    return TencentEastMoneyProvider()
