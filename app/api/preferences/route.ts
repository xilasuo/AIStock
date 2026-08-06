import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb, ensureSchema } from "../../../db";
import { requireApiUser, getCurrentUser } from "../../../lib/auth/auth";
import { tradingPreferences } from "../../../db/schema";
import { normalizePreferences, type TradingPreferences } from "../../../lib/utils/preferences";
import { shanghaiIso } from "../../../lib/utils/time";

export async function GET() {
  const unauthorized = await requireApiUser();
  if (unauthorized) return unauthorized;
  try {
    const user = await getCurrentUser();
    await ensureSchema();
    const db = getDb();
    const rows = await db
      .select()
      .from(tradingPreferences)
      .where(eq(tradingPreferences.userId, user.id))
      .limit(1);
    return NextResponse.json(normalizePreferences(rows[0]));
  } catch (error) {
    const message = error instanceof Error ? error.message : "读取风险偏好失败";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  const unauthorized = await requireApiUser();
  if (unauthorized) return unauthorized;
  try {
    const user = await getCurrentUser();
    const body = (await request.json().catch(() => null)) as Partial<TradingPreferences> | null;
    const next = normalizePreferences(body ?? {});
    await ensureSchema();
    const db = getDb();
    const updatedAt = shanghaiIso();
    await db
      .insert(tradingPreferences)
      .values({ userId: user.id, ...next, updatedAt })
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
          updatedAt,
        },
      });
    return NextResponse.json(next);
  } catch (error) {
    const message = error instanceof Error ? error.message : "保存风险偏好失败";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
