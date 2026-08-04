import type { getDb } from "../../db";
import { eq } from "drizzle-orm";
import { tradingPreferences } from "../../db/schema";

export type AppDb = ReturnType<typeof getDb>;

export type RiskProfile = "保守" | "平衡" | "激进";

export type TradingPreferences = {
  riskProfile: RiskProfile;
  maxLossPercent: number;
  maxConcentrationPercent: number;
  maxPositionPercent: number;
  enforceStopLoss: boolean;
  disciplineNote: string;
  stealthMode: boolean;
};

export const RISK_PRESETS: Record<RiskProfile, Omit<TradingPreferences, "disciplineNote">> = {
  保守: { riskProfile: "保守", maxLossPercent: 1, maxConcentrationPercent: 15, maxPositionPercent: 50, enforceStopLoss: true, stealthMode: false },
  平衡: { riskProfile: "平衡", maxLossPercent: 2, maxConcentrationPercent: 30, maxPositionPercent: 70, enforceStopLoss: true, stealthMode: false },
  激进: { riskProfile: "激进", maxLossPercent: 4, maxConcentrationPercent: 50, maxPositionPercent: 90, enforceStopLoss: false, stealthMode: false },
};

export const DEFAULT_PREFERENCES: TradingPreferences = {
  ...RISK_PRESETS["平衡"],
  disciplineNote: "",
  stealthMode: false,
};

export const RISK_PROFILE_LABELS: RiskProfile[] = ["保守", "平衡", "激进"];

function clampPercent(value: unknown, fallback: number): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.min(100, Math.max(0.1, num));
}

export function normalizePreferences(row: Partial<TradingPreferences> | undefined | null): TradingPreferences {
  if (!row) return DEFAULT_PREFERENCES;
  const riskProfile: RiskProfile =
    row.riskProfile === "保守" || row.riskProfile === "激进" ? row.riskProfile : "平衡";
  const preset = RISK_PRESETS[riskProfile];
  return {
    riskProfile,
    maxLossPercent: clampPercent(row.maxLossPercent, preset.maxLossPercent),
    maxConcentrationPercent: clampPercent(row.maxConcentrationPercent, preset.maxConcentrationPercent),
    maxPositionPercent: clampPercent(row.maxPositionPercent, preset.maxPositionPercent),
    enforceStopLoss: Boolean(row.enforceStopLoss),
    disciplineNote: typeof row.disciplineNote === "string" ? row.disciplineNote.slice(0, 500) : "",
    stealthMode: Boolean(row.stealthMode),
  };
}

export async function fetchPreferences(db: AppDb, userId?: number): Promise<TradingPreferences> {
  const rows = userId
    ? await db.select().from(tradingPreferences).where(eq(tradingPreferences.userId, userId)).limit(1)
    : await db.select().from(tradingPreferences).where(eq(tradingPreferences.id, 1)).limit(1);
  return normalizePreferences(rows[0]);
}
