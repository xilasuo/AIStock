"""本地云端模拟器（联调用，非生产）。

完全复刻 AIStock 线上部署的两个文件桥接口，便于在没有真实远程地址时
做「取数 -> 引擎 -> 推送 -> 页面读取」的端到端联调：

  POST /api/strategy-scan      校验 x-push-token，写入 <root>/strategy-scan/latest.json
  POST /api/writeback-signals  校验 x-push-token，写入 <root>/strategy-writeback/latest.json
  GET  /api/strategy-scan      返回 { ok, scan }
  GET  /api/writeback-signals  返回 { ok, writeback }
  GET  /health                 健康检查

落盘路径刻意对齐线上 Docker 卷：线上为 /data/.../latest.json（docker-compose 挂载 ./data），
这里把 ./data 换成 .tmp_cloud/data，仅挂载根不同，文件相对结构完全一致。

用法：
  python cloud_emulator.py [--port 8911] [--token TOKEN] [--data-root .tmp_cloud/data]
把 run_hub.py 的 --scan-url / --push-url 指向 http://localhost:8911/... 即可联调。
"""
from __future__ import annotations

import argparse
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

HERE = os.path.dirname(os.path.abspath(__file__))


class Handler(BaseHTTPRequestHandler):
    token: str = ""
    root: str = ""

    def _send(self, code: int, obj: dict):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        n = int(self.headers.get("Content-Length", "0") or "0")
        raw = self.rfile.read(n) if n else b"{}"
        return json.loads(raw.decode("utf-8"))

    def _auth_ok(self) -> bool:
        provided = self.headers.get("x-push-token") or (
            self.headers.get("authorization") or ""
        ).replace("Bearer ", "")
        return bool(self.token) and provided == self.token

    def do_GET(self):  # noqa: N802
        path = urlparse(self.path).path
        if path == "/health":
            self._send(200, {"ok": True})
            return
        if path in ("/api/strategy-scan", "/api/writeback-signals"):
            key = "scan" if path == "/api/strategy-scan" else "writeback"
            sub = "strategy-scan" if path == "/api/strategy-scan" else "strategy-writeback"
            fpath = os.path.join(self.root, sub, "latest.json")
            try:
                with open(fpath, "r", encoding="utf-8") as f:
                    self._send(200, {"ok": True, key: json.load(f)})
            except FileNotFoundError:
                self._send(404, {"ok": False, "error": f"尚未生成{key}数据"})
            return
        self._send(404, {"ok": False, "error": "not found"})

    def do_POST(self):  # noqa: N802
        path = urlparse(self.path).path
        if path not in ("/api/strategy-scan", "/api/writeback-signals"):
            self._send(404, {"ok": False, "error": "not found"})
            return
        if not self._auth_ok():
            self._send(401, {"ok": False, "error": "unauthorized"})
            return
        try:
            body = self._read_json()
        except Exception:
            self._send(400, {"ok": False, "error": "invalid json"})
            return
        if path == "/api/strategy-scan":
            if not isinstance(body, dict) or "selected" not in body:
                self._send(400, {"ok": False, "error": "invalid payload: missing 'selected'"})
            sub, key = "strategy-scan", "scan"
        else:
            if not isinstance(body, dict) or "signals" not in body:
                self._send(400, {"ok": False, "error": "invalid payload: missing 'signals'"})
            sub, key = "strategy-writeback", "writeback"
        fpath = os.path.join(self.root, sub, "latest.json")
        os.makedirs(os.path.dirname(fpath), exist_ok=True)
        with open(fpath, "w", encoding="utf-8") as f:
            json.dump(body, f, ensure_ascii=False, indent=2, default=str)
        print(f"[emulator] 收到 POST {path} -> 已写入 {fpath}")
        self._send(200, {"ok": True, "savedAt": _now()})

    def log_message(self, *args):  # 静默默认访问日志
        pass


def _now() -> str:
    from timeutil import sh_now

    return sh_now().isoformat(timespec="seconds")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8911)
    ap.add_argument("--token", default=os.environ.get("STRATEGY_PUSH_TOKEN") or "joint-test-secret-please-change-me-aaaaaaaaaa")
    ap.add_argument("--data-root", default=os.path.join(HERE, ".tmp_cloud", "data"))
    args = ap.parse_args()

    Handler.token = args.token
    Handler.root = args.data_root
    os.makedirs(Handler.root, exist_ok=True)
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"[emulator] 监听 http://127.0.0.1:{args.port}")
    print(f"[emulator] 数据根: {Handler.root}  (线上对应 /data)")
    print(f"[emulator] 期望 token: {args.token[:6]}...（与云端 STRATEGY_PUSH_TOKEN 一致）")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n[emulator] 已停止")


if __name__ == "__main__":
    main()
