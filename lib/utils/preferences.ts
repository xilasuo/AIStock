import type { getDb } from "../../db";
import { eq } from "drizzle-orm";
import { tradingPreferences } from "../../db/schema";
import { DEFAULT_TRADE_MODE, resolveTradeMode, type TradeMode } from "./trade-mode";

export type AppDb = ReturnType<typeof getDb>;

export type RiskProfile = "保守" | "平衡" | "激进";

export type TradingPreferences = {
  /** 操作模式（个人风格）：超短/短线/波段/长线，注入前端 LLM 与本地引擎 --mode */
  tradeMode: TradeMode;
  riskProfile: RiskProfile;
  maxLossPercent: number;
  maxConcentrationPercent: number;
  maxPositionPercent: number;
  enforceStopLoss: boolean;
  disciplineNote: string;
  stealthMode: boolean;
  /** 券商佣金费率（万 X，如 2.5 = 万2.5） */
  commissionRateTenThousandths: number;
  /** 单笔最低佣金（分；0 = 免5），卖出另计印花税 0.05% */
  minCommissionCents: number;
};

/** 交易费用默认：万2.5 + 最低 5 元（不免5），多数券商口径，可在设置中改为自己的费率 */
export const DEFAULT_FEE_SETTINGS = {
  commissionRateTenThousandths: 2.5,
  minCommissionCents: 500,
} as const;

// maxLossPercent 语义统一为「占买入价 % 的止损线」：买入未填最大亏损时，
// 自动以 买入价 ×(1 − maxLossPercent%) 建立止损提醒。
export const RISK_PRESETS: Record<RiskProfile, Omit<TradingPreferences, "tradeMode" | "disciplineNote" | "commissionRateTenThousandths" | "minCommissionCents">> = {
  保守: { riskProfile: "保守", maxLossPercent: 2, maxConcentrationPercent: 15, maxPositionPercent: 50, enforceStopLoss: true, stealthMode: false },
  平衡: { riskProfile: "平衡", maxLossPercent: 3, maxConcentrationPercent: 30, maxPositionPercent: 70, enforceStopLoss: true, stealthMode: false },
  激进: { riskProfile: "激进", maxLossPercent: 6, maxConcentrationPercent: 50, maxPositionPercent: 90, enforceStopLoss: true, stealthMode: false },
};

export const DEFAULT_PREFERENCES: TradingPreferences = {
  ...RISK_PRESETS["平衡"],
  tradeMode: DEFAULT_TRADE_MODE,
  disciplineNote: "",
  stealthMode: false,
  ...DEFAULT_FEE_SETTINGS,
};

export const RISK_PROFILE_LABELS: RiskProfile[] = ["保守", "平衡", "激进"];

function clampPercent(value: unknown, fallback: number): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.min(100, Math.max(0.1, num));
}

function clampNonNegative(value: unknown, fallback: number): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num) || num < 0) return fallback;
  return Math.min(100_000, num);
}

/** normalizePreferences 入参：兼容 DB 行（各字段原始类型）与前端 Partial 提交 */
export type PreferencesInput = {
  tradeMode?: unknown;
  riskProfile?: unknown;
  maxLossPercent?: unknown;
  maxConcentrationPercent?: unknown;
  maxPositionPercent?: unknown;
  enforceStopLoss?: unknown;
  disciplineNote?: unknown;
  stealthMode?: unknown;
  commissionRateTenThousandths?: unknown;
  minCommissionCents?: unknown;
};

export function normalizePreferences(row: PreferencesInput | undefined | null): TradingPreferences {
  if (!row) return DEFAULT_PREFERENCES;
  const riskProfile: RiskProfile =
    row.riskProfile === "保守" || row.riskProfile === "激进" ? row.riskProfile : "平衡";
  const preset = RISK_PRESETS[riskProfile];
  return {
    tradeMode: resolveTradeMode(row.tradeMode),
    riskProfile,
    maxLossPercent: clampPercent(row.maxLossPercent, preset.maxLossPercent),
    maxConcentrationPercent: clampPercent(row.maxConcentrationPercent, preset.maxConcentrationPercent),
    maxPositionPercent: clampPercent(row.maxPositionPercent, preset.maxPositionPercent),
    enforceStopLoss: typeof row.enforceStopLoss === "boolean" ? row.enforceStopLoss : preset.enforceStopLoss,
    disciplineNote: typeof row.disciplineNote === "string" ? row.disciplineNote.slice(0, 500) : "",
    stealthMode: typeof row.stealthMode === "boolean" ? row.stealthMode : preset.stealthMode,
    commissionRateTenThousandths: clampNonNegative(row.commissionRateTenThousandths, DEFAULT_FEE_SETTINGS.commissionRateTenThousandths) || DEFAULT_FEE_SETTINGS.commissionRateTenThousandths,
    minCommissionCents: clampNonNegative(row.minCommissionCents, DEFAULT_FEE_SETTINGS.minCommissionCents),
  };
}

/** 按成交金额与费用设置估算单笔手续费（分）：佣金 max(金额×费率, 最低佣金)，卖出再加印花税 0.05%。 */
export function estimateTradeFeeCents(amountYuan: number, side: "买入" | "卖出", prefs: TradingPreferences): number {
  const rate = (prefs.commissionRateTenThousandths || DEFAULT_FEE_SETTINGS.commissionRateTenThousandths) / 10_000;
  const minCommission = prefs.minCommissionCents ?? DEFAULT_FEE_SETTINGS.minCommissionCents;
  const commission = Math.max(Math.round(amountYuan * 100 * rate), Math.round(minCommission));
  const stampTax = side === "卖出" ? Math.round(amountYuan * 100 * 0.0005) : 0;
  return commission + stampTax;
}

export async function fetchPreferences(db: AppDb, userId?: number): Promise<TradingPreferences> {
  const rows = userId
    ? await db.select().from(tradingPreferences).where(eq(tradingPreferences.userId, userId)).limit(1)
    : await db.select().from(tradingPreferences).where(eq(tradingPreferences.id, 1)).limit(1);
  return normalizePreferences(rows[0]);
}
