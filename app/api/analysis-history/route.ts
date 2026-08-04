import { and, desc, eq } from "drizzle-orm";
import { ensureSchema, getDb } from "../../../db";
import { analysisReports } from "../../../db/schema";
import { isStockCode } from "../../../lib/domain/domain";
import { getCurrentUser, requireApiUser } from "../../../lib/auth/auth";

export async function GET(request: Request) {
  const unauthorized = await requireApiUser();
  if (unauthorized) return unauthorized;
  try {
    const user = await getCurrentUser();
    const symbol = new URL(request.url).searchParams.get("symbol")?.trim() ?? "";
    if (!isStockCode(symbol)) {
      return Response.json({ error: "股票代码不正确" }, { status: 400 });
    }
    await ensureSchema();
    const reports = await getDb()
      .select({
        id: analysisReports.id,
        symbol: analysisReports.symbol,
        name: analysisReports.name,
        priceCents: analysisReports.priceCents,
        priceMillis: analysisReports.priceMillis,
        marketTime: analysisReports.marketTime,
        source: analysisReports.source,
        mode: analysisReports.mode,
        summary: analysisReports.summary,
        createdAt: analysisReports.createdAt,
      })
      .from(analysisReports)
      .where(and(eq(analysisReports.symbol, symbol), eq(analysisReports.userId, user.id)))
      .orderBy(desc(analysisReports.id))
      .limit(20);
    return Response.json({ reports });
  } catch {
    return Response.json({ error: "分析历史暂时无法读取" }, { status: 503 });
  }
}

export async function DELETE(request: Request) {
  const unauthorized = await requireApiUser();
  if (unauthorized) return unauthorized;
  try {
    const user = await getCurrentUser();
    const url = new URL(request.url);
    const symbol = url.searchParams.get("symbol")?.trim() ?? "";
    const id = Number(url.searchParams.get("id"));
    if (!isStockCode(symbol) || !Number.isInteger(id) || id <= 0) {
      return Response.json({ error: "分析记录不正确" }, { status: 400 });
    }
    await ensureSchema();
    const [deleted] = await getDb()
      .delete(analysisReports)
      .where(and(eq(analysisReports.id, id), eq(analysisReports.symbol, symbol), eq(analysisReports.userId, user.id)))
      .returning({ id: analysisReports.id });
    return deleted
      ? Response.json({ ok: true })
      : Response.json({ error: "分析记录不存在" }, { status: 404 });
  } catch {
    return Response.json({ error: "分析记录删除失败" }, { status: 500 });
  }
}
