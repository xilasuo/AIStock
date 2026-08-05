import { NextRequest, NextResponse } from "next/server";
import { requireApiUser } from "../../../lib/auth/auth";
import { getRealtime } from "../../../lib/market/market-data";

/**
 * 轻量行情接口：只返回价格与涨跌幅，不拉 K 线/财务/公告。
 * 供前端 1 分钟轮询刷新持仓/关注/提醒的价格，替代过去每 5 分钟走一次完整分析接口。
 * 单次最多 20 只，防止被滥用打爆免费行情源。
 */
const MAX_SYMBOLS = 20;

export async function POST(request: NextRequest) {
  const unauthorized = await requireApiUser();
  if (unauthorized) return unauthorized;
  try {
    const body = (await request.json().catch(() => null)) as { symbols?: unknown } | null;
    const raw = Array.isArray(body?.symbols) ? body.symbols : [];
    const symbols = [...new Set(
      raw
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter((item) => /^\d{6}$/.test(item)),
    )].slice(0, MAX_SYMBOLS);
    if (!symbols.length) {
      return NextResponse.json({ error: "缺少有效的股票代码" }, { status: 400 });
    }

    const fetchedAt = new Date().toISOString();
    const quotes: Record<string, { price: number; changePercent: number; fetchedAt: string }> = {};
    // 逐只拉取，单只失败不影响其余；getRealtime 内部带 15s 内存缓存兜底
    await Promise.all(symbols.map(async (symbol) => {
      try {
        const quote = await getRealtime(symbol, true);
        if (quote && Number.isFinite(quote.price)) {
          quotes[symbol] = {
            price: quote.price,
            changePercent: quote.changePercent ?? 0,
            fetchedAt,
          };
        }
      } catch {
        // 单只失败静默跳过，前端保留旧价
      }
    }));

    return NextResponse.json({ quotes, fetchedAt });
  } catch (error) {
    const message = error instanceof Error ? error.message : "行情刷新失败";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
