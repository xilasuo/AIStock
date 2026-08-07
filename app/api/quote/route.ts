import { NextRequest, NextResponse } from "next/server";
import { requireApiUser } from "../../../lib/auth/auth";
import { getRealtime } from "../../../lib/market/market-data";

/**
 * 轻量行情接口：只返回价格与涨跌幅，不拉 K 线/财务/公告。
 * 供前端轮询刷新持仓/关注/提醒的价格，替代过去每 5 分钟走一次完整分析接口。
 *
 * 单次请求不再硬性截断到 20 只（此前会导致监控列表 + 持仓超过 20 只时，
 * 排在后面的股票拿不到行情、大屏跑马灯显示「暂无行情」）。
 * 改为分批并行请求：每批 20 只、最多 240 只，既避免一次性打爆免费行情源，
 * 也保证所有有效代码都能取到行情。
 */
const BATCH_SIZE = 20;
const MAX_SYMBOLS = 240;

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
    // 分批并行拉取，单只失败不影响其余；getRealtime 内部带 15s 内存缓存兜底
    for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
      const batch = symbols.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(async (symbol) => {
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
    }

    return NextResponse.json({ quotes, fetchedAt });
  } catch (error) {
    const message = error instanceof Error ? error.message : "行情刷新失败";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
