#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
dump_config.py —— 把 strategy_config.yaml 摊平结果以 JSON 输出到 stdout。

供前端「策略扫描」面板初始化表单（与 CLI 共用同一份 strategy_config.yaml）：
  - 前端 API（app/api/strategy-scan/config/route.ts）在真实 Node 部署下 exec 本脚本读取最新 YAML（含人工改动）。
  - 本地引擎守护进程（local_engine_server.js）的 GET /config 同样调用本脚本。

复用 trading_agent 的零依赖 YAML 加载器（config.load_strategy_yaml），
与 run_hub.py 处于同一 stdlib-only 环境，无需第三方依赖。
"""

import json
import os
import sys

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)

from config import load_strategy_yaml  # noqa: E402


def main() -> None:
    cfg = load_strategy_yaml()
    # 输出嵌套结构 {screener, market, signal, optim}，前端再经 toNested/fromNested 转换。
    print(json.dumps(cfg or {}, ensure_ascii=False))


if __name__ == "__main__":
    main()
