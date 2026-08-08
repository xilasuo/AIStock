"""MCP over Streamable HTTP 客户端（stdlib，无第三方依赖）

实现 JSON-RPC 2.0 的 initialize / tools/list / tools/call，维护会话。
本地端点自动 bypass 代理；远程端点沿用环境代理（与本机沙箱一致）。
"""
from __future__ import annotations

import json
import os
import urllib.request
import urllib.error
from typing import Any, Optional


def first_text(result: dict) -> str:
    """从 tools/call 的标准返回里提取第一段文本内容。

    MCP 返回结构：{"result": {"content": [{"type": "text", "text": "..."}]}}
    """
    if not result:
        return ""
    content = result.get("result", {}).get("content") or []
    for item in content:
        if item.get("type") == "text":
            return item.get("text", "")
    # 兼容 content 直接是字符串的变体
    if isinstance(result.get("result", {}).get("content"), str):
        return result["result"]["content"]
    return json.dumps(result.get("result", {}), ensure_ascii=False)


class MCPHTTPClient:
    """最小可用的 MCP Streamable HTTP 客户端。"""

    def __init__(self, endpoint: str, headers: Optional[dict] = None, timeout: int = 30):
        self.endpoint = endpoint
        self.headers = dict(headers or {})
        self.timeout = timeout
        self.session_id: Optional[str] = None
        self._opener = self._build_opener(endpoint)

    @staticmethod
    def _build_opener(endpoint: str):
        # 本地端点直连（bypass 代理），远程端点沿用环境代理
        is_local = ("localhost" in endpoint) or ("127.0.0.1" in endpoint)
        if is_local:
            proxy = {}
        else:
            proxy = {
                "http": os.environ.get("HTTP_PROXY", ""),
                "https": os.environ.get("HTTPS_PROXY", ""),
            }
        return urllib.request.build_opener(urllib.request.ProxyHandler(proxy))

    def _parse_body(self, body: str) -> dict:
        body = body.strip()
        if not body:
            return {}
        if body.startswith("{"):
            return json.loads(body)
        # SSE：提取最后一帧 data: {...}
        out: dict = {}
        for line in body.splitlines():
            line = line.strip()
            if line.startswith("data:"):
                chunk = line[5:].strip()
                if chunk:
                    try:
                        out = json.loads(chunk)
                    except json.JSONDecodeError:
                        continue
        return out

    def _post(self, payload: dict) -> dict:
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(self.endpoint, data=data, method="POST")
        req.add_header("Content-Type", "application/json")
        req.add_header("Accept", "application/json, text/event-stream")
        for k, v in self.headers.items():
            if v:
                req.add_header(k, v)
        if self.session_id:
            req.add_header("Mcp-Session-Id", self.session_id)
        try:
            resp = self._opener.open(req, timeout=self.timeout)
        except urllib.error.HTTPError as e:  # 错误体也可能含 JSON
            raw = e.read().decode("utf-8", "replace")
            raise RuntimeError(f"MCP HTTP {e.code}: {raw[:300]}") from e
        sid = resp.headers.get("Mcp-Session-Id") or resp.headers.get("mcp-session-id")
        if sid:
            self.session_id = sid
        return self._parse_body(resp.read().decode("utf-8", "replace"))

    def initialize(self) -> dict:
        r = self._post({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "trading-agent", "version": "1.0.0"},
            },
        })
        # 发送 initialized 通知（无需等待返回）
        try:
            self._post({"jsonrpc": "2.0", "method": "notifications/initialized"})
        except Exception:
            pass
        return r

    def list_tools(self) -> dict:
        r = self._post({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})
        return r

    def call_tool(self, name: str, arguments: Optional[dict] = None) -> dict:
        return self._post({
            "jsonrpc": "2.0", "id": 3, "method": "tools/call",
            "params": {"name": name, "arguments": arguments or {}},
        })


class MCPConnector:
    """连接器基类：持有 MCP 客户端，按工具名调用并缓存 tools 列表。

    tool_map 允许把高层方法名映射到连接器实际暴露的工具名（不同 MCP 实现
    命名略有差异时，配置即可适配，无需改代码）。
    """

    name = "mcp"

    def __init__(
        self,
        endpoint: str,
        headers: Optional[dict] = None,
        enabled: bool = False,
        tool_map: Optional[dict] = None,
        timeout: int = 30,
    ):
        self.endpoint = endpoint
        self.enabled = bool(endpoint) and enabled
        self._client: Optional[MCPHTTPClient] = None
        self._tools: dict = {}
        self._connect_failed: bool = False  # 端点不可达后置位，本次会话内不再重试
        self.tool_map = tool_map or {}
        self._extra_headers = headers or {}

    def _client_for(self) -> MCPHTTPClient:
        if self._client is None:
            self._client = MCPHTTPClient(self.endpoint, self._extra_headers, timeout=30)
        return self._client

    def connect(self) -> dict:
        if not self.enabled or self._connect_failed:
            return {}
        if not self._tools:
            try:
                self._client_for().initialize()
                r = self._client_for().list_tools()
                self._tools = {t["name"]: t for t in r.get("result", {}).get("tools", [])}
            except Exception as e:  # noqa: BLE001
                # 端点不可达 / 网络异常 / 鉴权失败：本次会话降级为不可用，
                # 后续 has_tool / call 直接走兜底直连，避免每次请求都重连并报错。
                self._connect_failed = True
                self.enabled = False
                print(f"[mcp] 连接器 {self.name} 连接失败，已降级直连: {type(e).__name__}: {e}")
        return self._tools

    def has_tool(self, method: str) -> bool:
        if not self.enabled:
            return False
        try:
            self.connect()
        except Exception:  # noqa: BLE001
            return False
        return self._resolve(method) in self._tools

    def _resolve(self, method: str) -> str:
        """高层方法名 -> 实际工具名（默认同名）。"""
        return self.tool_map.get(method, method)

    def call(self, method: str, **arguments: Any) -> dict:
        if not self.enabled:
            raise RuntimeError(f"连接器 {self.name} 未启用")
        self.connect()
        return self._client_for().call_tool(self._resolve(method), arguments)

    def call_text(self, method: str, **arguments: Any) -> str:
        return first_text(self.call(method, **arguments))

    def get_schema(self, method: str) -> dict:
        self.connect()
        return self._tools.get(self._resolve(method), {})
