"""上海时间工具（stdlib-only，零第三方依赖）。

A 股引擎所有面向用户的「生成于 / 时间戳」一律用上海时区输出。
上海为固定 UTC+8（中国 1991 年后无夏令时），直接用固定偏移即可，
避免 `datetime.now()` 依赖宿主时区 —— 例如 Docker 容器默认 UTC，
`datetime.now()` 会产出 UTC 时间，导致云端页面显示与本地差 8 小时。

用法：
    from timeutil import sh_now, sh_now_aware
    sh_now().isoformat(timespec="seconds")            # naive 上海时间
    sh_now().strftime("%Y-%m-%d %H:%M:%S")            # 报告/推送用
    sh_now_aware().strftime("%Y-%m-%d %H:%M:%S %z")   # 带 +0800 偏移
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

# 上海（Asia/Shanghai）恒为 UTC+8，无夏令时
SH_TZ = timezone(timedelta(hours=8), name="Asia/Shanghai")


def sh_now() -> datetime:
    """当前上海时间（naive、无 tzinfo），与历史数据格式保持一致。"""
    return datetime.now(SH_TZ).replace(tzinfo=None)


def sh_now_aware() -> datetime:
    """当前上海时间（带 +08:00 tzinfo），用于需要显式时区偏移的场景。"""
    return datetime.now(SH_TZ)
