"""桥接层（对应架构图「WorkBuddy 中枢 · 桥接连接器」）

把上层策略与底层数据源/执行通道解耦：
- 数据请求（K线/估值）路由到 westock / tdx / 腾讯·东财直连（按可用性）。
- 执行回写（下单）与提醒推送统一从这里下发到已启用的连接器。

连接器是否启用完全由 config.connectors 决定：填了端点即为真，留空退回直连。
"""
from __future__ import annotations

import config
from data import provider
from connectors import WestockConnector, TdxConnector, WeComPusher


def build_connectors(cfg: config.AppConfig):
    """依据配置构建连接器集合（留空端点即不启用）。"""
    cc = cfg.connectors
    westock = WestockConnector(
        endpoint=cc.westock_url, token=cc.westock_token, enabled=bool(cc.westock_url)
    )
    tdx = TdxConnector(
        endpoint=cc.tdx_url, api_key=cc.tdx_api_key, enabled=bool(cc.tdx_url)
    )
    push = WeComPusher(webhook_url=cc.wecom_webhook)
    return westock, tdx, push


class ConnectorHub:
    """连接器中枢：路由数据请求到可用源，并下发执行/推送。"""

    def __init__(self, cfg: config.AppConfig):
        self.cfg = cfg
        self.westock, self.tdx, self.push = build_connectors(cfg)

    # ---------- 数据路由 ----------
    def request_kline(self, code: str, beg: str, end: str) -> list[dict]:
        # 能力探测（has_tool）可能触发网络握手，包一层避免探测失败中断回退路径
        try:
            tdx_ok = self.tdx.enabled and self.tdx.has_tool("stock_kline")
        except Exception:  # noqa: BLE001
            tdx_ok = False
        if tdx_ok:
            try:
                # tdx 需要 market(0=深,1=沪) + 纯数字代码；解析失败则回退直连
                market = 1 if code.startswith(("6", "9")) else 0
                raw = self.tdx.stock_kline(market=market, code=code, period=4)
                parsed = self._try_parse_kline(raw)
                # 校验确为 K 线（含 date 字段），否则回退，避免把畸形数据喂引擎
                if parsed and all(isinstance(b, dict) and b.get("date") for b in parsed):
                    return parsed
            except Exception as e:  # noqa: BLE001
                print(f"[bridge] tdx kline 失败，回退直连: {e}")

        try:
            westock_ok = self.westock.enabled and self.westock.has_tool("get_kline")
        except Exception:  # noqa: BLE001
            westock_ok = False
        if westock_ok:
            try:
                raw = self.westock.get_kline(code)
                parsed = self._try_parse_kline(raw)
                if parsed and all(isinstance(b, dict) and b.get("date") for b in parsed):
                    return parsed
            except Exception as e:  # noqa: BLE001
                print(f"[bridge] westock kline 失败，回退直连: {e}")
        return provider.fetch_kline(code, beg, end)

    def request_quote(self, code: str) -> dict:
        try:
            westock_ok = self.westock.enabled and self.westock.has_tool("get_quote")
        except Exception:  # noqa: BLE001
            westock_ok = False
        if westock_ok:
            try:
                raw = self.westock.get_quote(code)
                parsed = self._try_parse_quote(raw)
                if parsed:
                    return parsed
            except Exception as e:  # noqa: BLE001
                print(f"[bridge] westock quote 失败，回退直连: {e}")
        return provider.fetch_quote(code)

    # ---------- 执行回写（交易接口） ----------
    def writeback_signals(self, signals: list[dict], dry_run: bool = True) -> list[dict]:
        """把信号列表写回通达信。仅 tdx 连接器提供交易接口。

        signals: [{"code","side","price","quantity"}]
        返回每笔的执行回执（含 dry_run 标记）。
        """
        # 能力探测（has_tool）可能触发网络握手，包一层避免探测失败中断回写流程
        try:
            tdx_ok = self.tdx.enabled and self.tdx.has_tool("place_order")
        except Exception:  # noqa: BLE001
            tdx_ok = False
        if not tdx_ok:
            print("[bridge] 无可用 tdx 交易接口，跳过回写")
            return []
        receipts = []
        for s in signals:
            try:
                r = self.tdx.place_order(
                    code=s["code"], side=s["side"],
                    price=float(s["price"]), quantity=int(s["quantity"]),
                    dry_run=dry_run,
                )
                receipts.append({"code": s["code"], "side": s["side"], "receipt": r})
            except Exception as e:  # noqa: BLE001
                receipts.append({"code": s["code"], "side": s["side"], "error": str(e)})
        return receipts

    # ---------- 提醒推送 ----------
    def notify(self, scan_result: dict) -> dict:
        if not self.push.enabled:
            print("[bridge] 未配置企业微信 webhook，跳过推送")
            return {"errcode": -2, "errmsg": "webhook 未配置"}
        return self.push.notify_scan(scan_result)

    # ---------- 解析辅助 ----------
    @staticmethod
    def _try_parse_kline(raw: str) -> list:
        if not raw:
            return []
        try:
            obj = __import__("json").loads(raw)
            # 兼容 {"kline": [...]} 或 [..., ...]
            if isinstance(obj, list):
                return obj
            if isinstance(obj, dict):
                for key in ("kline", "data", "bars", "list"):
                    if isinstance(obj.get(key), list):
                        return obj[key]
        except Exception:  # noqa: BLE001
            return []
        return []

    @staticmethod
    def _try_parse_quote(raw: str) -> dict:
        if not raw:
            return {}
        try:
            obj = __import__("json").loads(raw)
            if isinstance(obj, dict):
                # westock-mcp 返回 {ok,data,message}；只接受含必要字段的行情对象，
                # 否则视为不可用、回退直连（避免残缺/错误数据污染引擎打分）。
                if obj.get("price") is not None or obj.get("close") is not None or obj.get("name"):
                    return obj
        except Exception:  # noqa: BLE001
            return {}
        return {}
