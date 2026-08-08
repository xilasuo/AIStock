"""腾讯自选股 westock-mcp 连接器

定位：数据源（行情 / 估值 / K线 / 财务）。westock-mcp 以查询类工具为主，
不提供回写/推送能力；执行回写走 tdx-connector，提醒推送走 WeComPusher。

工具名基于 westock 常见命名；若实际 MCP 暴露名不同，可在 tool_map 中覆盖。
"""
from __future__ import annotations

from typing import Optional

from .mcp import MCPConnector


class WestockConnector(MCPConnector):
    name = "westock"

    def __init__(
        self,
        endpoint: str,
        token: Optional[str] = None,
        enabled: bool = False,
        tool_map: Optional[dict] = None,
    ):
        headers = {}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        # 高层方法 -> 实际工具名（对齐 WorkBuddy 托管的 westock-mcp 真实工具名）
        default_map = {
            "search": "data_search",
            "get_quote": "data_quote",
            "get_kline": "data_kline",
            "get_finance": "data_finance",
        }
        super().__init__(
            endpoint,
            headers=headers,
            enabled=enabled,
            tool_map={**default_map, **(tool_map or {})},
        )

    # ---- 高层方法 ----
    def search(self, keyword: str, type: str = "stock") -> str:
        return self.call_text("search", keyword=keyword, type=type)

    def get_quote(self, code: str) -> str:
        return self.call_text("get_quote", code=code)

    def get_kline(self, code: str, period: str = "day", limit: int = 60) -> str:
        return self.call_text("get_kline", code=code, period=period, limit=limit)

    def get_finance(self, code: str) -> str:
        return self.call_text("get_finance", code=code)
