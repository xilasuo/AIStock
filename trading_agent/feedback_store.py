"""用户反馈存储（对应架构图「用户 → 本项目 → 优化策略」闭环）

用户在前端「策略扫描」页对某只标的/某次信号给出有效/无效评价，
经 POST /api/feedback（云端）或 POST /feedback（Agent 服务）落盘到这里。
optimizer 读取这些反馈，调整下一轮目标函数权重（强化被认可的策略）。
"""
from __future__ import annotations

import json
import os
import threading
from timeutil import sh_now

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
FEEDBACK_FILE = os.path.join(BASE_DIR, "feedback.jsonl")
_LOCK = threading.Lock()


def save_feedback(feedback: dict) -> dict:
    """追加一条反馈。feedback: {code, name, verdict(有效/无效), note, source}"""
    record = {
        "ts": sh_now().isoformat(timespec="seconds"),
        "code": feedback.get("code", ""),
        "name": feedback.get("name", ""),
        "verdict": feedback.get("verdict", "有效"),
        "note": feedback.get("note", ""),
        "source": feedback.get("source", "agent"),
    }
    with _LOCK:
        with open(FEEDBACK_FILE, "a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
    return record


def load_feedbacks() -> list:
    if not os.path.exists(FEEDBACK_FILE):
        return []
    out = []
    with _LOCK:
        with open(FEEDBACK_FILE, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    try:
                        out.append(json.loads(line))
                    except json.JSONDecodeError:
                        continue
    return out


def feedback_summary() -> dict:
    """汇总反馈，供 optimizer 调整权重。返回 {verdict_count, positive_ratio}。"""
    fs = load_feedbacks()
    if not fs:
        return {"count": 0, "positive": 0, "positive_ratio": 0.0}
    pos = sum(1 for x in fs if x.get("verdict") in ("有效", "positive", "good"))
    return {
        "count": len(fs),
        "positive": pos,
        "positive_ratio": pos / len(fs),
    }
