import { and, desc, eq, isNull } from "drizzle-orm";
import { ensureSchema, getDb } from "../../../db";
import { alertRules, tradeRecords } from "../../../db/schema";
import { findInvalidSell, isIsoDate, isStockCode, isTradeSide, toCents, toTenThousandths } from "../../../lib/domain/domain";
import { buildMaxLossAlerts } from "../../../lib/domain/trade-import";
import { canonicalStockName } from "../../../lib/domain/stocks";
import { getCurrentUser, requireApiUser } from "../../../lib/auth/auth";
import { shanghaiDate, shanghaiIso } from "../../../lib/utils/time";

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
    // 可选：技术面止损价（元），来自分析支撑位，优先于 maxLoss 反推止损
    const stopLossNumber = Number(payload.stopLoss);
    const stopLoss = payload.stopLoss !== undefined && payload.stopLoss !== null && payload.stopLoss !== "" && Number.isFinite(stopLossNumber) && stopLossNumber > 0
      ? stopLossNumber
      : undefined;

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
    if (side === "买入" && stopLoss !== undefined && stopLoss >= rawPrice) {
      return Response.json({ error: "止损价必须低于买入价" }, { status: 400 });
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
    // 有每股风险（maxLoss）或技术面止损价（stopLoss）时，自动生成止损/止盈提醒
    if (side === "买入" && (riskPerShareTenThousandths !== null || stopLoss !== undefined)) {
      const baseAlerts = buildMaxLossAlerts({
        symbol,
        name,
        currentPriceMillis: priceMillis,
        maxLossTenThousandths: riskPerShareTenThousandths ?? 0,
        stopLoss,
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
        createdAt: shanghaiIso(),
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

    // 先把可编辑字段归一化到「合并后交易」，再统一做与 POST 同源的校验。
    const next = { ...existing };
    if (payload.price !== undefined) {
      const rawPrice = Number(payload.price);
      if (!Number.isFinite(rawPrice) || rawPrice <= 0) {
        return Response.json({ error: "价格不正确" }, { status: 400 });
      }
      const priceTenThousandths = toTenThousandths(rawPrice);
      next.priceTenThousandths = priceTenThousandths;
      next.priceMillis = Math.round(priceTenThousandths / 10);
      next.priceCents = Math.round(priceTenThousandths / 100);
    }
    if (payload.quantity !== undefined) {
      const quantity = Number(payload.quantity);
      if (!Number.isInteger(quantity) || quantity <= 0) {
        return Response.json({ error: "数量不正确" }, { status: 400 });
      }
      next.quantity = quantity;
    }
    if (payload.fee !== undefined) {
      const fee = Number(payload.fee);
      if (!Number.isFinite(fee) || fee < 0) {
        return Response.json({ error: "费用不正确" }, { status: 400 });
      }
      next.feeCents = toCents(fee);
    }
    if (payload.reason !== undefined) next.reason = String(payload.reason ?? "").trim();
    if (payload.otherReason !== undefined) next.otherReason = String(payload.otherReason ?? "").trim() || null;
    if (payload.tradeDate !== undefined) {
      const tradeDate = String(payload.tradeDate);
      if (!isIsoDate(tradeDate)) {
        return Response.json({ error: "交易日期格式不正确" }, { status: 400 });
      }
      const today = shanghaiDate();
      if (tradeDate > today) {
        return Response.json({ error: "交易日期不能晚于今天" }, { status: 400 });
      }
      next.tradeDate = tradeDate;
    }

    // 买入记录可再编辑风险计划（止损/止盈/最大亏损）。
    const riskEdited =
      payload.maxLoss !== undefined ||
      payload.stopLoss !== undefined ||
      payload.takeProfit1 !== undefined ||
      payload.takeProfit2 !== undefined;
    let nextMaxLossCents: number | null = next.maxLossCents ?? null;
    let nextStopLoss: number | undefined;
    let nextTakeProfit1: number | undefined;
    let nextTakeProfit2: number | undefined;
    if (next.side === "买入" && riskEdited) {
      const maxLossNumber = Number(payload.maxLoss);
      const rawMaxLoss =
        payload.maxLoss === undefined || payload.maxLoss === null || payload.maxLoss === "" || maxLossNumber === 0
          ? null
          : maxLossNumber;
      const stopLossNumber = Number(payload.stopLoss);
      nextStopLoss =
        payload.stopLoss !== undefined && payload.stopLoss !== null && payload.stopLoss !== "" && Number.isFinite(stopLossNumber) && stopLossNumber > 0
          ? stopLossNumber
          : undefined;
      const takeProfit1Number = Number(payload.takeProfit1);
      nextTakeProfit1 =
        payload.takeProfit1 !== undefined && payload.takeProfit1 !== null && payload.takeProfit1 !== "" && Number.isFinite(takeProfit1Number) && takeProfit1Number > 0
          ? takeProfit1Number
          : undefined;
      const takeProfit2Number = Number(payload.takeProfit2);
      nextTakeProfit2 =
        payload.takeProfit2 !== undefined && payload.takeProfit2 !== null && payload.takeProfit2 !== "" && Number.isFinite(takeProfit2Number) && takeProfit2Number > 0
          ? takeProfit2Number
          : undefined;
      nextMaxLossCents = rawMaxLoss === null ? null : toCents(rawMaxLoss);
      if (rawMaxLoss !== null && (!Number.isFinite(rawMaxLoss) || nextMaxLossCents === null || nextMaxLossCents <= 0)) {
        return Response.json({ error: "最大亏损必须是安全范围内的正数" }, { status: 400 });
      }
      next.maxLossCents = nextMaxLossCents;
    }

    if (next.reason.length === 0 || next.reason.length > 200) {
      return Response.json({ error: "请选择或填写交易原因" }, { status: 400 });
    }
    const priceTenThousandths = next.priceTenThousandths ?? 0;
    if (
      !Number.isFinite(priceTenThousandths) ||
      priceTenThousandths <= 0 ||
      !Number.isSafeInteger(priceTenThousandths) ||
      !Number.isSafeInteger(next.quantity) ||
      next.quantity <= 0 ||
      !Number.isSafeInteger(priceTenThousandths * next.quantity)
    ) {
      return Response.json({ error: "价格和数量必须是有效的正数，且交易金额不能超出安全范围" }, { status: 400 });
    }
    if (!Number.isFinite(next.feeCents) || next.feeCents < 0 || !Number.isSafeInteger(next.feeCents)) {
      return Response.json({ error: "费用必须是安全范围内的非负数" }, { status: 400 });
    }
    if (next.maxLossCents !== null && next.maxLossCents !== undefined && (!Number.isSafeInteger(next.maxLossCents) || next.maxLossCents <= 0)) {
      return Response.json({ error: "最大亏损必须是安全范围内的非负数" }, { status: 400 });
    }
    const riskPerShareTenThousandths =
      nextMaxLossCents === null || nextMaxLossCents === undefined
        ? null
        : Math.round(nextMaxLossCents * 100 / next.quantity);
    if (
      next.side === "买入" &&
      riskPerShareTenThousandths !== null &&
      riskPerShareTenThousandths >= priceTenThousandths
    ) {
      return Response.json({ error: "最大亏损必须小于本次买入金额" }, { status: 400 });
    }
    if (next.side === "买入" && nextStopLoss !== undefined && nextStopLoss >= priceTenThousandths / 10000) {
      return Response.json({ error: "止损价必须低于买入价" }, { status: 400 });
    }

    const allTrades = await db.select().from(tradeRecords).where(eq(tradeRecords.userId, user.id));
    const invalidSell = findInvalidSell(allTrades.map((t) => (t.id === id ? next : t)));
    if (invalidSell) {
      return Response.json({
        error: `按交易日期排序后可卖数量不足：${invalidSell.symbol}可卖${invalidSell.availableQuantity}股，本次卖出${invalidSell.requestedQuantity}股`,
      }, { status: 400 });
    }

    const updates: Partial<typeof tradeRecords.$inferInsert> = {
      priceCents: next.priceCents,
      priceMillis: next.priceMillis,
      priceTenThousandths: next.priceTenThousandths,
      quantity: next.quantity,
      feeCents: next.feeCents,
      reason: next.reason,
      otherReason: next.otherReason,
      tradeDate: next.tradeDate,
      maxLossCents: next.maxLossCents,
      updatedAt: shanghaiIso(),
    };

    let trade;
    // 买入且风险字段被编辑时，删除该股票未确认的旧提醒并重新生成。
    if (next.side === "买入" && riskEdited && (riskPerShareTenThousandths !== null || nextStopLoss !== undefined)) {
      const priceMillis = next.priceMillis ?? Math.round(priceTenThousandths / 10);
      const baseAlerts = buildMaxLossAlerts({
        symbol: next.symbol,
        name: next.name,
        currentPriceMillis: priceMillis,
        maxLossTenThousandths: riskPerShareTenThousandths ?? 0,
        stopLoss: nextStopLoss,
      });
      const targets = baseAlerts.map((alert) => {
        if (alert.type === "止盈一" && nextTakeProfit1 !== undefined) {
          return { ...alert, targetTenThousandths: Math.round(toTenThousandths(nextTakeProfit1)) };
        }
        if (alert.type === "止盈二" && nextTakeProfit2 !== undefined) {
          return { ...alert, targetTenThousandths: Math.round(toTenThousandths(nextTakeProfit2)) };
        }
        return alert;
      }).map((alert) => ({
        userId: user.id,
        symbol: alert.symbol,
        name: alert.name,
        type: alert.type,
        targetPriceCents: Math.round(alert.targetTenThousandths / 100),
        targetPriceMillis: Math.round(alert.targetTenThousandths / 10),
        createdAt: shanghaiIso(),
      }));
      const [tradeRows] = await db.batch([
        db.update(tradeRecords).set(updates).where(eq(tradeRecords.id, id)).returning(),
        db.delete(alertRules).where(and(eq(alertRules.userId, user.id), eq(alertRules.symbol, next.symbol), isNull(alertRules.acknowledgedAt))),
        db.insert(alertRules).values(targets),
      ]);
      trade = tradeRows[0];
    } else {
      [trade] = await db.update(tradeRecords).set(updates).where(eq(tradeRecords.id, id)).returning();
    }
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
