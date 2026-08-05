# -*- coding: utf-8 -*-
"""
将 db/seeds/a_stock_list.ts 中的全量 A 股名称生成拼音首字母缩写表
（db/seeds/a_stock_pinyin.ts），供搜索联想「输入拼音首字母 → 命中股票」使用。

用法（需 pypinyin，仅生成时一次性使用，运行时零依赖）：
  python scripts/gen_stock_pinyin.py

生成规则：
  1. 规范化名称：去空格/全角空格，全角字母数字转半角（"万  科Ａ" → "万科A"）。
  2. 把名称切成「连续中文段 + 非中文段」（英文/数字/* 等原样保留）。
  3. 中文段整体调用 pypinyin 词典消歧取首字母（"平安银行" → payh，而非 payx），
     解决多音字问题（银行读 háng、长城读 cháng、厦门读 xià 等）。
  4. 非中文段转小写原样保留（"*ST美丽" → *stml、"TCL科技" → tclkj）。
"""
import re
from pathlib import Path

from pypinyin import lazy_pinyin, Style

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "db/seeds/a_stock_list.ts"
OUT = ROOT / "db/seeds/a_stock_pinyin.ts"


def normalize_name(name: str) -> str:
    n = re.sub(r"[\s\u3000]+", "", name)
    return re.sub(r"[Ａ-Ｚａ-ｚ０-９]", lambda m: chr(ord(m.group(0)) - 0xFEE0), n)


def pinyin_abbr(name: str) -> str:
    n = normalize_name(name)
    segments = re.findall(r"[\u4e00-\u9fff]+|[A-Za-z0-9*]+", n)
    out: list[str] = []
    for seg in segments:
        if re.match(r"[\u4e00-\u9fff]", seg[0]):
            pys = lazy_pinyin(seg, style=Style.FIRST_LETTER)
            out.extend(py if py else "" for py in pys)
        else:
            out.append(seg.lower())
    return "".join(out)


def main() -> None:
    src_text = SRC.read_text(encoding="utf-8")
    pairs = re.findall(r'^\s*"(\d{6})":\s*"([^"]+)",', src_text, re.M)
    if not pairs:
        raise SystemExit(f"未从 {SRC} 解析到任何股票，请检查格式。")

    rows: dict[str, str] = {}
    for code, name in pairs:
        rows[code] = pinyin_abbr(name)

    lines = [
        "// Auto-generated from a_stock_list.ts + pypinyin (scripts/gen_stock_pinyin.py)",
        f"// Generated at: {__import__('datetime').datetime.now().astimezone().strftime('%Y-%m-%dT%H:%M:%S%z')}",
        f"// Total: {len(rows)} A-share stocks (沪深京) — 拼音首字母缩写，供搜索联想",
        "",
        "const A_STOCK_PINYIN: Record<string, string> = {",
    ]
    for code in sorted(rows):
        lines.append(f'  "{code}": "{rows[code]}",')
    lines.extend(["};", "", "export default A_STOCK_PINYIN;"])

    content = "\n".join(lines) + "\n"
    OUT.write_text(content, encoding="utf-8")
    size_kb = len(content.encode("utf-8")) / 1024
    empties = [c for c, a in rows.items() if not a]
    print(f"Written {OUT} ({len(rows)} entries, {size_kb:.1f}KB)")
    if empties:
        print(f"WARNING: {len(empties)} 空缩写: {empties[:10]}")


if __name__ == "__main__":
    main()
