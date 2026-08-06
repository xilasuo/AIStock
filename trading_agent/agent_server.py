"""trading_agent 作为可调度 Agent · HTTP 服务入口

对应架构图「本项目 ↔ WorkBuddy」控制流：WorkBuddy（或复盘应用）经 HTTP 调度
trading_agent，下发「运行选股 / 取状态 / 健康检查」，trading_agent 复用
core.loop.run 产出并可选触发回写/推送。

端点：
  GET  /health               健康检查
  POST /run                  运行闭环（body 可选覆盖参数：top_n, beg, end, fast_ma...）
  GET  /status               最近一次运行摘要
  POST /feedback             接收用户反馈（user -> 优化策略 闭环）
  GET  /kline/<code>.svg     K线技术面板（深色标注 SVG，前端 <img> 直用）
  GET  /kline/<code>.json    K线标注数据（现价/泡沫顶/突破位/回踩点/生死线）
"""
from __future__ import annotations

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

import config
from core import loop
from reports.report import write_scan_json


_LAST = {"result": None, "lock": threading.Lock()}
_KLINE_CACHE = {}            # code -> (ts, svg, markers)
_KLINE_CACHE_TTL = 1800      # 秒


def _kline_panel(code: str) -> tuple[str, dict]:
    """生成（带 TTL 缓存）K线面板。返回 (svg_text, markers)。"""
    now = time.time()
    hit = _KLINE_CACHE.get(code)
    if hit and now - hit[0] < _KLINE_CACHE_TTL:
        return hit[1], hit[2]
    from render_kline import render_kline_panel
    _, markers, svg = render_kline_panel(code)
    _KLINE_CACHE[code] = (now, svg, markers)
    return svg, markers


def run_once(cfg: config.AppConfig) -> dict:
    result = loop.run(cfg)
    payload = write_scan_json(result, cfg)
    with _LAST["lock"]:
        _LAST["result"] = payload
    return payload


def handle_run(body: dict) -> dict:
    """运行闭环。

    支持「WorkBuddy 中枢注入数据」：body 可带 prefetched={klines,quotes,hot}，
    由中枢从 westock/tdx 连接器取来后注入，引擎用中枢数据计算（自身不连 MCP）。
    不带 prefetched 时回退默认数据源（腾讯/东财直连）。

    no_writeback=true：本进程不回写/推送（交由 WorkBuddy 中枢执行）。
    """
    cfg = config.AppConfig()
    if isinstance(body, dict):
        if "top_n" in body:
            cfg.screener.top_n = int(body["top_n"])
        if "beg" in body:
            cfg.beg = body["beg"]
        if "end" in body:
            cfg.end = body["end"]
        if "fast_ma" in body:
            cfg.signal.fast_ma = int(body["fast_ma"])
        if "slow_ma" in body:
            cfg.signal.slow_ma = int(body["slow_ma"])
        if body.get("no_optim"):
            cfg.optim.enabled = False

    # 中枢注入数据 -> StaticProvider
    dp = None
    pre = body.get("prefetched") if isinstance(body, dict) else None
    if isinstance(pre, dict):
        from data.provider import StaticProvider
        dp = StaticProvider(
            klines=pre.get("klines") or {},
            quotes=pre.get("quotes") or {},
            hot=pre.get("hot") or [],
        )

    result = loop.run(cfg, dp=dp)
    payload = write_scan_json(result, cfg)
    with _LAST["lock"]:
        _LAST["result"] = payload

    # 回写 + 推送：仅独立模式（已配连接器且未要求中枢代管）时由本进程执行
    if not body.get("no_writeback"):
        from main import _run_connectors
        import argparse

        fake_args = argparse.Namespace(no_writeback=False)
        _run_connectors(cfg, result, fake_args)
    return payload


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, obj: dict):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/health":
            self._send(200, {"ok": True, "service": "trading-agent"})
        elif path == "/status":
            with _LAST["lock"]:
                res = _LAST["result"]
            if res is None:
                self._send(200, {"ok": True, "last_run": None})
            else:
                self._send(200, {
                    "ok": True,
                    "last_run": {
                        "generatedAt": res.get("generatedAt"),
                        "selectedCount": res.get("selectedCount"),
                        "universeSize": res.get("universeSize"),
                    },
                })
        elif path.startswith("/kline/"):
            rest = path[len("/kline/"):]
            if rest.endswith(".svg"):
                code = rest[:-4].strip()
                if not code or not code.isalnum():
                    self._send(400, {"ok": False, "error": "bad code, use /kline/<code>.svg"})
                    return
                try:
                    svg, _ = _kline_panel(code)
                except Exception as e:  # noqa: BLE001
                    self._send(500, {"ok": False, "error": str(e)})
                    return
                data = svg.encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "image/svg+xml; charset=utf-8")
                self.send_header("Cache-Control", f"public, max-age={_KLINE_CACHE_TTL}")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            elif rest.endswith(".json"):
                code = rest[:-5].strip()
                if not code or not code.isalnum():
                    self._send(400, {"ok": False, "error": "bad code, use /kline/<code>.json"})
                    return
                try:
                    _, markers = _kline_panel(code)
                except Exception as e:  # noqa: BLE001
                    self._send(500, {"ok": False, "error": str(e)})
                    return
                self._send(200, {"ok": True, "code": code, "markers": markers})
            else:
                self._send(404, {"ok": False, "error": "use /kline/<code>.svg 或 /kline/<code>.json"})
        else:
            self._send(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        path = urlparse(self.path).path
        length = int(self.headers.get("Content-Length", 0) or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw.decode("utf-8", "replace") or "{}")
        except Exception:
            body = {}

        if path == "/run":
            try:
                payload = handle_run(body)
                self._send(200, {"ok": True, "scan": payload})
            except Exception as e:  # noqa: BLE001
                self._send(500, {"ok": False, "error": str(e)})
        elif path == "/feedback":
            # 接收用户反馈 -> 落盘供 optimizer 消费
            try:
                from feedback_store import save_feedback
                save_feedback(body)
                self._send(200, {"ok": True})
            except Exception as e:  # noqa: BLE001
                self._send(500, {"ok": False, "error": str(e)})
        else:
            self._send(404, {"ok": False, "error": "not found"})

    def log_message(self, *args):  # 静默
        return


def serve(cfg: config.AppConfig, host: str = "127.0.0.1", port: int = 8080):
    httpd = ThreadingHTTPServer((host, port), Handler)
    print(f"trading-agent 调度服务已启动: http://{host}:{port}  (Ctrl+C 退出)")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        httpd.shutdown()
        print("已停止。")


if __name__ == "__main__":
    import os
    import sys

    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    c = config.AppConfig()
    serve(c, host=config.AGENT_BIND_HOST, port=config.AGENT_BIND_PORT)
