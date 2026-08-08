import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { withAuth } from "../../../lib/auth/auth";
import { tradingPreferences } from "../../../db/schema";
import { normalizePreferences, type TradingPreferences } from "../../../lib/utils/preferences";
import { shanghaiIso } from "../../../lib/utils/time";

export const GET = withAuth(async (_request, { user }) => {
  const db = getDb();
  const rows = await db
    .select()
    .from(tradingPreferences)
    .where(eq(tradingPreferences.userId, user.id))
    .limit(1);
  return NextResponse.json(normalizePreferences(rows[0]));
}, "读取风险偏好失败");

export const PUT = withAuth(async (request, { user }) => {
  const body = (await request.json().catch(() => null)) as Partial<TradingPreferences> | null;
  const next = normalizePreferences(body ?? {});
  const db = getDb();
  const updatedAt = shanghaiIso();
  await db
    .insert(tradingPreferences)
    .values({ userId: user.id, ...next, quickPrompts: JSON.stringify(next.quickPrompts ?? []), updatedAt })
    .onConflictDoUpdate({
      target: tradingPreferences.userId,
      set: {
        tradeMode: next.tradeMode,
        riskProfile: next.riskProfile,
        maxLossPercent: next.maxLossPercent,
        maxConcentrationPercent: next.maxConcentrationPercent,
        maxPositionPercent: next.maxPositionPercent,
        enforceStopLoss: next.enforceStopLoss,
        disciplineNote: next.disciplineNote,
        stealthMode: next.stealthMode,
        commissionRateTenThousandths: next.commissionRateTenThousandths,
        minCommissionCents: next.minCommissionCents,
        quickPrompts: JSON.stringify(next.quickPrompts ?? []),
        updatedAt,
      },
    });
  return NextResponse.json(next);
}, "保存风险偏好失败");
