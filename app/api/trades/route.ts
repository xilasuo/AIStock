import { and, desc, eq } from "drizzle-orm";
import { ensureSchema, getDb } from "../../../db";
import { alertRules, tradeRecords } from "../../../db/schema";
import { findInvalidSell, isIsoDate, isStockCode, isTradeSide, toCents, toTenThousandths } from "../../../lib/domain";
import { buildMaxLossAlerts } from "../../../lib/trade-import";
import { canonicalStockName } from "../../../lib/stocks";
import { getCurrentUser, requireApiUser } from "../../../lib/auth";
import { shanghaiDate, shanghaiIso } from "../../../lib/time";

export async function GET() {
  const unauthorized = await requireApiUser();
  if (unauthorized) return unauthorized;
  try {
    const user = await getCurrentUser();
    await ensureSchema();
    const rows = await getDb()
      .select()
      .from(tradeRecords)
      .where(eq(tradeRecords.userId, user.id))
      .orderBy(desc(tradeRecords.tradeDate), desc(tradeRecords.id))
      .limit(500);
    return Response.json({ trades: rows });
  } catch {
    return Response.json({ error: "交易记录暂时无法读取" }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const unauthorized = await requireApiUser();
  if (unauthorized) return unauthorized;
  try {
    const user = await getCurrentUser();
    const payload = await request.json() as Record<string, unknown>;
    const symbol = String(payload.symbol ?? "").trim();
    const name = canonicalStockName(symbol, String(payload.name ?? "").trim());
    const side = payload.side;
    const rawPrice = Number(payload.price);
    const maxLossNumber = Number(payload.maxLoss);
    const rawMaxLoss =
      payload.maxLoss === undefined || payload.maxLoss === null || payload.maxLoss === "" || maxLossNumber === 0
        ? null
        : maxLossNumber;
    const rawFee = payload.fee === undefined || payload.fee === null || payload.fee === ""
      ? 0
      : Number(payload.fee);
    const priceTenThousandths = toTenThousandths(rawPrice);
    const priceMillis = Math.round(priceTenThousandths / 10);
    const priceCents = Math.round(priceTenThousandths / 100);
    const quantity = Number(payload.quantity);
    const tradeDate = payload.tradeDate;
    const reason = String(payload.reason ?? "").trim();
    const otherReason = String(payload.otherReason ?? "").trim();
    const maxLossCents = rawMaxLoss === null ? null : toCents(rawMaxLoss);
    const feeCents = toCents(rawFee);

    if (!isStockCode(symbol) || !name || name.length > 30) {
      return Response.json({ error: "股票代码或名称不正确" }, { status: 400 });
    }
    if (!isTradeSide(side)) {
      return Response.json({ error: "买卖方向不正确" }, { status: 400 });
    }
    if (
      !Number.isFinite(rawPrice) ||
      priceTenThousandths <= 0 ||
      !Number.isSafeInteger(priceTenThousandths) ||
      !Number.isSafeInteger(quantity) ||
      quantity <= 0 ||
      !Number.isSafeInteger(priceTenThousandths * quantity)
    ) {
      return Response.json({ error: "价格和数量必须是有效的正数，且交易金额不能超出安全范围" }, { status: 400 });
    }
    if (!isIsoDate(tradeDate)) {
      return Response.json({ error: "交易日期不正确" }, { status: 400 });
    }
    const today = shanghaiDate();
    if (tradeDate > today) {
      return Response.json({ error: "交易日期不能晚于今天" }, { status: 400 });
    }
    if (!reason || reason.length > 200) {
      return Response.json({ error: "请选择或填写交易原因" }, { status: 400 });
    }
    if (
      (rawMaxLoss !== null && (!Number.isFinite(rawMaxLoss) || maxLossCents === null || maxLossCents <= 0)) ||
      !Number.isFinite(rawFee) ||
      feeCents < 0 ||
      !Number.isSafeInteger(maxLossCents ?? 0) ||
      !Number.isSafeInteger(feeCents)
    ) {
      return Response.json({ error: "最大亏损和费用必须是安全范围内的非负数" }, { status: 400 });
    }
    const riskPerShareTenThousandths =
      maxLossCents === null ? null : Math.round(maxLossCents * 100 / quantity);
    if (
      side === "买入" &&
      riskPerShareTenThousandths !== null &&
      riskPerShareTenThousandths >= priceTenThousandths
    ) {
      return Response.json({ error: "最大亏损必须小于本次买入金额" }, { status: 400 });
    }

    await ensureSchema();
    const db = getDb();
    const existingTrades = await db.select().from(tradeRecords).where(eq(tradeRecords.userId, user.id));
    const nextId = existingTrades.reduce((largest, trade) => Math.max(largest, trade.id), 0) + 1;
    const invalidSell = side === "卖出"
      ? findInvalidSell([...existingTrades, {
          id: nextId,
          symbol,
          name,
          side,
          priceCents,
          priceMillis,
          priceTenThousandths,
          quantity,
          tradeDate,
          reason,
          maxLossCents,
          feeCents,
        }])
      : null;
    if (invalidSell) {
      return Response.json({
        error: `按交易日期排序后可卖数量不足：${invalidSell.symbol}可卖${invalidSell.availableQuantity}股，本次卖出${invalidSell.requestedQuantity}股`,
      }, { status: 400 });
    }
    const tradeValues = {
      userId: user.id,
      symbol,
      name,
      side,
      priceCents,
      priceMillis,
      priceTenThousandths,
      quantity,
      tradeDate,
      reason,
      maxLossCents,
      feeCents,
      otherReason: otherReason || null,
      createdAt: shanghaiIso(),
    };
    let trade;
    if (side === "买入" && riskPerShareTenThousandths !== null) {
      const baseAlerts = buildMaxLossAlerts({
        symbol,
        name,
        currentPriceMillis: priceMillis,
        maxLossTenThousandths: riskPerShareTenThousandths,
      });
      // 用户可手动指定止盈价（元），覆盖系统自动推算的止盈一/止盈二
      const takeProfit1Number = Number(payload.takeProfit1);
      const takeProfit2Number = Number(payload.takeProfit2);
      const hasTakeProfit1 = payload.takeProfit1 !== undefined && payload.takeProfit1 !== null && payload.takeProfit1 !== "" && Number.isFinite(takeProfit1Number) && takeProfit1Number > 0;
      const hasTakeProfit2 = payload.takeProfit2 !== undefined && payload.takeProfit2 !== null && payload.takeProfit2 !== "" && Number.isFinite(takeProfit2Number) && takeProfit2Number > 0;
      const targets = baseAlerts.map((alert) => {
        if (alert.type === "止盈一" && hasTakeProfit1) {
          return { ...alert, targetTenThousandths: Math.round(toTenThousandths(takeProfit1Number)) };
        }
        if (alert.type === "止盈二" && hasTakeProfit2) {
          return { ...alert, targetTenThousandths: Math.round(toTenThousandths(takeProfit2Number)) };
        }
        return alert;
      }).map((alert) => ({
        userId: user.id,
        symbol: alert.symbol,
        name: alert.name,
        type: alert.type,
        targetPriceCents: Math.round(alert.targetTenThousandths / 100),
        targetPriceMillis: Math.round(alert.targetTenThousandths / 10),
      }));
      const [tradeRows] = await db.batch([
        db.insert(tradeRecords).values(tradeValues).returning(),
        db.insert(alertRules).values(targets),
      ]);
      trade = tradeRows[0];
    } else {
      [trade] = await db.insert(tradeRecords).values(tradeValues).returning();
    }
    return Response.json({ trade }, { status: 201 });
  } catch {
    return Response.json({ error: "交易记录保存失败，请稍后重试" }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  const unauthorized = await requireApiUser();
  if (unauthorized) return unauthorized;
  try {
    const payload = await request.json() as Record<string, unknown>;
    const id = Number(payload.id);
    if (!Number.isInteger(id) || id <= 0) {
      return Response.json({ error: "交易记录 ID 不正确" }, { status: 400 });
    }
    await ensureSchema();
    const db = getDb();
    const user = await getCurrentUser();
    const [existing] = await db.select().from(tradeRecords)
      .where(and(eq(tradeRecords.id, id), eq(tradeRecords.userId, user.id)));
    if (!existing) {
      return Response.json({ error: "交易记录不存在" }, { status: 404 });
    }
    const updates: Partial<typeof tradeRecords.$inferInsert> = {};
    if (payload.price !== undefined) {
      const rawPrice = Number(payload.price);
      if (!Number.isFinite(rawPrice) || rawPrice <= 0) {
        return Response.json({ error: "价格不正确" }, { status: 400 });
      }
      const priceTenThousandths = toTenThousandths(rawPrice);
      updates.priceTenThousandths = priceTenThousandths;
      updates.priceMillis = Math.round(priceTenThousandths / 10);
      updates.priceCents = Math.round(priceTenThousandths / 100);
    }
    if (payload.quantity !== undefined) {
      const quantity = Number(payload.quantity);
      if (!Number.isInteger(quantity) || quantity <= 0) {
        return Response.json({ error: "数量不正确" }, { status: 400 });
      }
      updates.quantity = quantity;
    }
    if (payload.fee !== undefined) {
      const fee = Number(payload.fee);
      if (!Number.isFinite(fee) || fee < 0) {
        return Response.json({ error: "费用不正确" }, { status: 400 });
      }
      updates.feeCents = toCents(fee);
    }
    if (payload.reason !== undefined) updates.reason = String(payload.reason ?? "").trim();
    if (payload.otherReason !== undefined) updates.otherReason = String(payload.otherReason ?? "").trim() || null;
    if (payload.tradeDate !== undefined) {
      const tradeDate = String(payload.tradeDate);
      if (!isIsoDate(tradeDate)) {
        return Response.json({ error: "交易日期格式不正确" }, { status: 400 });
      }
      updates.tradeDate = tradeDate;
    }
    if (Object.keys(updates).length === 0) {
      return Response.json({ error: "没有可更新的内容" }, { status: 400 });
    }
    const [trade] = await db.update(tradeRecords).set(updates).where(eq(tradeRecords.id, id)).returning();
    return Response.json({ trade });
  } catch {
    return Response.json({ error: "交易记录更新失败" }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const unauthorized = await requireApiUser();
  if (unauthorized) return unauthorized;
  try {
    const url = new URL(request.url);
    const id = Number(url.searchParams.get("id"));
    if (!Number.isInteger(id) || id <= 0) {
      return Response.json({ error: "交易记录 ID 不正确" }, { status: 400 });
    }
    await ensureSchema();
    const db = getDb();
    const user = await getCurrentUser();
    const [existing] = await db.select().from(tradeRecords)
      .where(and(eq(tradeRecords.id, id), eq(tradeRecords.userId, user.id)));
    if (!existing) {
      return Response.json({ error: "交易记录不存在" }, { status: 404 });
    }
    await db.delete(tradeRecords).where(and(eq(tradeRecords.id, id), eq(tradeRecords.userId, user.id)));
    return Response.json({ ok: true });
  } catch {
    return Response.json({ error: "交易记录删除失败" }, { status: 500 });
  }
}
