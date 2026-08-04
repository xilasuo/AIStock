import { eq } from "drizzle-orm";
import { ensureSchema, getDb } from "../../../db";
import { alertRules, tradeRecords } from "../../../db/schema";
import { findInvalidSell } from "../../../lib/domain/domain";
import { buildMaxLossAlerts, extractMaxLossPercent, type MaxLossAlert, parseBrokerCsv, prepareTradeInput } from "../../../lib/domain/trade-import";
import { getCurrentUser, requireApiUser } from "../../../lib/auth/auth";
import { shanghaiIso } from "../../../lib/utils/time";

type ImportError = { line: number; symbol: string; reason: string };

export async function POST(request: Request) {
  const unauthorized = await requireApiUser();
  if (unauthorized) return unauthorized;
  try {
    const user = await getCurrentUser();
    const payload = await request.json() as Record<string, unknown>;
    const csv = String(payload.csv ?? "").trim();
    if (!csv) {
      return Response.json({ error: "请粘贴券商导出的交割单 CSV" }, { status: 400 });
    }

    const rows = parseBrokerCsv(csv);
    if (!rows.length) {
      return Response.json({ error: "没有识别到可导入的成交记录（请检查表头是否包含代码/方向/价格/数量/日期）" }, { status: 400 });
    }

    await ensureSchema();
    const db = getDb();
    const existingTrades = await db.select().from(tradeRecords).where(eq(tradeRecords.userId, user.id));
    let nextId = existingTrades.reduce((largest, trade) => Math.max(largest, trade.id), 0) + 1;
    const running = [...existingTrades];
    const errors: ImportError[] = [];
    const toInsert: Array<typeof tradeRecords.$inferInsert> = [];

    const ordered = [...rows].sort((a, b) => (a.tradeDate < b.tradeDate ? -1 : a.tradeDate > b.tradeDate ? 1 : 0));
    const alertInserts: Array<typeof alertRules.$inferInsert> = [];
    for (const row of ordered) {
      const maxLoss = extractMaxLossPercent(row.reason);
      const prepared = prepareTradeInput({
        symbol: row.symbol,
        name: row.name,
        side: row.side,
        price: row.price,
        quantity: row.quantity,
        tradeDate: row.tradeDate,
        fee: row.fee,
        reason: row.reason,
        maxLoss: maxLoss === null ? undefined : maxLoss,
      });
      if (prepared.error || !prepared.values) {
        errors.push({ line: row.line, symbol: row.symbol, reason: prepared.error ?? "校验失败" });
        continue;
      }
      const candidate = {
        id: nextId,
        userId: user.id,
        symbol: prepared.values.symbol,
        name: prepared.values.name,
        side: prepared.values.side,
        priceCents: prepared.values.priceCents,
        priceMillis: prepared.values.priceMillis,
        priceTenThousandths: prepared.values.priceTenThousandths,
        quantity: prepared.values.quantity,
        tradeDate: prepared.values.tradeDate,
        reason: prepared.values.reason,
        maxLossCents: prepared.values.maxLossCents,
        feeCents: prepared.values.feeCents,
        otherReason: null,
        createdAt: shanghaiIso(),
        updatedAt: shanghaiIso(),
      };
      if (candidate.side === "卖出") {
        const invalid = findInvalidSell([...running, candidate]);
        if (invalid) {
          errors.push({
            line: row.line,
            symbol: candidate.symbol,
            reason: `可卖数量不足：可卖${invalid.availableQuantity}股，本次卖出${invalid.requestedQuantity}股`,
          });
          continue;
        }
      }
      if (candidate.side === "买入" && candidate.maxLossCents) {
        const riskPerShareTenThousandths = Math.round((candidate.maxLossCents * 100) / candidate.quantity);
        const alerts = buildMaxLossAlerts({
          symbol: candidate.symbol,
          name: candidate.name,
          currentPriceMillis: candidate.priceMillis,
          maxLossTenThousandths: riskPerShareTenThousandths,
        }).map((alert: MaxLossAlert) => ({
          userId: user.id,
          symbol: alert.symbol,
          name: alert.name,
          type: alert.type,
          targetPriceCents: Math.round(alert.targetTenThousandths / 100),
          targetPriceMillis: Math.round(alert.targetTenThousandths / 10),
        }));
        alertInserts.push(...alerts);
      }
      toInsert.push(candidate);
      running.push(candidate);
      nextId += 1;
    }

    if (toInsert.length) {
      await db.insert(tradeRecords).values(toInsert);
    }
    if (alertInserts.length) {
      await db.insert(alertRules).values(alertInserts);
    }

    return Response.json({
      inserted: toInsert.length,
      skipped: errors.length,
      errors,
    }, { status: 200 });
  } catch {
    return Response.json({ error: "导入失败，请检查 CSV 格式后重试" }, { status: 500 });
  }
}
