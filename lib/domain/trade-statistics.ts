/**
 * 交易绩效统计（Trading performance analytics）
 *
 * 把"记账"升级为"复盘分析"：在基础盈亏之外，提供胜率、盈亏比、期望值、
 * 最大回撤、平均持仓天数、连胜/连亏、按计划/按月/按标的/按标签分布等指标。
 *
 * 纯函数，不依赖数据库或网络，便于单元测试，也方便在客户端直接基于
 * 已加载的 trades / capitalFlows / reviews 计算。
 *
 * 对标：TraderVue / Edgewonk 的绩效面板。
 */
import { buildTradeCycles, calculatePortfolio, type CapitalFlow, type Trade } from "./domain";
import type { TradingPreferences } from "../utils/preferences";

/** 初判卡片单项：verdict 决定卡片颜色（good=绿/info=蓝/warn=红） */
export type EarlyProfileItem = {
  key: string;
  label: string;
  verdict: "good" | "info" | "warn";
  text: string;
};

/** 情绪驱动买入（与 Dashboard buyReasons 文案一致），初判中单独归为一类 */
const EMOTIONAL_BUY_REASONS = new Set(["怕踏空追涨", "冲动买入"]);

/** 单笔买入金额（分）：优先十毫（价格×10000），回退毫/分。与 domain 口径一致。 */
function tradeAmountCents(trade: Trade): number {
  const priceTenThousandths =
    trade.priceTenThousandths ?? (trade.priceMillis ?? trade.priceCents * 10) * 10;
  return Math.round((priceTenThousandths * trade.quantity) / 100) + (trade.feeCents ?? 0);
}

/**
 * 「交易画像 · 初判」：仅凭 3 笔以上买入记录就能给出的早期洞察，
 * 让新用户在等待完整清仓周期之前，立刻看到记录的价值。
 * 纯函数、零外部依赖；所有结论都来自已录入的买卖字段，不猜测。
 */
export function buildEarlyProfile(
  buyTrades: Trade[],
  totalAssetsCents: number | null,
  prefs: Pick<TradingPreferences, "maxConcentrationPercent" | "commissionRateTenThousandths">,
): EarlyProfileItem[] {
  if (buyTrades.length < 3) return [];
  const total = buyTrades.length;
  const items: EarlyProfileItem[] = [];

  // 1) 计划纪律：几笔买入设了"最多接受亏损"（复盘闭环的锚）
  const withPlan = buyTrades.filter((trade) => (trade.maxLossCents ?? 0) > 0).length;
  const planRatio = withPlan / total;
  if (planRatio >= 0.9) {
    items.push({ key: "plan", label: "计划纪律", verdict: "good", text: `${withPlan}/${total} 笔买入都设了止损计划，起步就在守纪律。` });
  } else if (planRatio >= 0.5) {
    items.push({ key: "plan", label: "计划纪律", verdict: "info", text: `${withPlan}/${total} 笔设了止损计划，还有 ${total - withPlan} 笔没设——没有计划就没有复盘基准。` });
  } else {
    items.push({ key: "plan", label: "计划纪律", verdict: "warn", text: `${total} 笔买入里只有 ${withPlan} 笔设了止损。先养成"买前写最大亏损"的习惯，再谈选股。` });
  }

  // 2) 买入理由构成：规则买 vs 情绪买（情绪驱动是最容易亏钱的入场方式）
  const emotional = buyTrades.filter((trade) => EMOTIONAL_BUY_REASONS.has(trade.reason)).length;
  const emoRatio = emotional / total;
  if (emoRatio >= 0.5) {
    items.push({ key: "reason", label: "买入理由", verdict: "warn", text: `${emotional}/${total} 笔是情绪驱动（怕踏空/冲动），这是最容易亏钱的入场方式，下次先写清逻辑再下单。` });
  } else if (emoRatio > 0) {
    items.push({ key: "reason", label: "买入理由", verdict: "info", text: `${emotional}/${total} 笔是情绪买入，其余有明确依据——把依据也写进备注，复盘才能对账。` });
  } else {
    items.push({ key: "reason", label: "买入理由", verdict: "good", text: `买入都以基本面/技术面依据为主，入场有章法。` });
  }

  // 3) 单笔集中度：最大单笔金额 vs 用户单股上限（账户资金缺失时跳过）
  if (totalAssetsCents != null && totalAssetsCents > 0) {
    const maxAmount = Math.max(...buyTrades.map(tradeAmountCents));
    const maxPct = (maxAmount / totalAssetsCents) * 100;
    if (maxPct > prefs.maxConcentrationPercent) {
      items.push({
        key: "concentration",
        label: "单笔集中度",
        verdict: "warn",
        text: `最大一笔买入占资产约 ${maxPct.toFixed(1)}%，超过你 ${prefs.maxConcentrationPercent}% 的单股上限——先降单票风险。`,
      });
    }
  }

  // 4) 交易成本：平均手续费占成交额（最低 5 元门槛在小单时会被放大）
  const amountSum = buyTrades.reduce((sum, trade) => sum + tradeAmountCents(trade), 0);
  const feeSum = buyTrades.reduce((sum, trade) => sum + (trade.feeCents ?? 0), 0);
  if (amountSum > 0) {
    const avgFeePct = ((feeSum / amountSum) * 1000); // 千分比
    if (avgFeePct > 1) {
      items.push({
        key: "fee",
        label: "交易成本",
        verdict: "info",
        text: `平均每笔手续费占成交额约 ${avgFeePct.toFixed(1)}‰——最低 5 元门槛在小单上会被放大，金额太小时成本偏高。`,
      });
    }
  }

  return items;
}

export type TagStat = {
  tag: string;
  reviews: number;
  realizedCents: number;
  winRate: number;
};

/** 按买入理由的盈亏归因：把每笔已清仓周期按建仓理由聚合，
 * 回答「哪种买入逻辑在赚钱、哪种在亏钱」——这是行为复盘最该看的维度。 */
export type ReasonStat = {
  reason: string;
  trades: number;
  realizedCents: number;
  winRate: number;
};

export type MonthlyStat = {
  month: string;
  realizedCents: number;
  trades: number;
  winRate: number;
};

export type SymbolStat = {
  symbol: string;
  name: string;
  realizedCents: number;
  trades: number;
  winRate: number;
};

export type BuySummaryStat = {
  symbol: string;
  name: string;
  buyCount: number;
  buyQuantity: number;
  buyAmountCents: number;
  sellCount: number;
  sellQuantity: number;
  currentPosition: number;
  realizedCents: number;
};

export type EquityPoint = {
  date: string;
  equityCents: number;
};

export type TradeStatistics = {
  /** 已平仓交易笔数（完整买卖周期） */
  totalTrades: number;
  realizedCents: number;
  grossProfitCents: number;
  grossLossCents: number;
  winningTrades: number;
  losingTrades: number;
  scratchTrades: number;
  /** 胜率 = 盈利笔数 / (盈利 + 亏损)，剔除平手 */
  winRate: number;
  /** 盈亏比 = 总盈利 / |总亏损|，无亏损时为 Infinity */
  profitFactor: number;
  /** 期望值 = 每笔平均盈亏 */
  expectancyCents: number;
  avgWinCents: number;
  avgLossCents: number;
  avgHoldingDays: number;
  maxHoldingDays: number;
  maxDrawdownCents: number;
  maxDrawdownPercent: number;
  bestTradeCents: number;
  worstTradeCents: number;
  currentWinStreak: number;
  longestWinStreak: number;
  currentLossStreak: number;
  longestLossStreak: number;
  byMonth: MonthlyStat[];
  bySymbol: SymbolStat[];
  byTag: TagStat[];
  byReason: ReasonStat[];
  bySellReason: ReasonStat[];
  equityCurve: EquityPoint[];
  planAdherence: PlanAdherence;
};

export type ReviewInput = {
  cycleEndTradeId: number | null;
  symbol: string;
  resultCents: number | null;
  tags: string[];
  followedPlan: boolean;
};

export type PlanAdherence = {
  /** 已复盘笔数 */
  total: number;
  /** 按计划执行笔数 */
  followed: number;
  /** 计划执行率 = 按计划 / 已复盘 */
  rate: number;
  /** 按计划执行的累计盈亏（分） */
  followedRealizedCents: number;
  /** 偏离计划执行的累计盈亏（分） */
  deviatedRealizedCents: number;
  /** 按计划执行的胜率 */
  followedWinRate: number;
  /** 偏离计划执行的胜率 */
  deviatedWinRate: number;
};

function daysBetween(startIso: string, endIso: string): number {
  const start = Date.parse(`${startIso}T00:00:00Z`);
  const end = Date.parse(`${endIso}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, Math.round((end - start) / 86_400_000));
}

function monthKey(iso: string): string {
  return iso.slice(0, 7);
}

function safeDivide(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

/** 按股票汇总买入记录：买入次数、买入股数/金额、卖出次数、当前持仓、已实现盈亏。
 * 与按周期统计的 bySymbol 不同，这里基于原始交易流水统计，包含持仓中的标的。
 * 已实现盈亏复用 domain 的移动平均成本算法，与持仓逻辑保持一致。
 */
export function calculateBuySummary(trades: Trade[]): BuySummaryStat[] {
  const bySymbol = new Map<string, Trade[]>();
  for (const trade of trades) {
    const list = bySymbol.get(trade.symbol) ?? [];
    list.push(trade);
    bySymbol.set(trade.symbol, list);
  }

  const stats: BuySummaryStat[] = [];
  for (const [symbol, list] of bySymbol.entries()) {
    const summary = list.reduce(
      (acc, trade) => {
        if (trade.side === "买入") {
          acc.buyCount += 1;
          acc.buyQuantity += trade.quantity;
          const priceTenThousandths =
            trade.priceTenThousandths ?? (trade.priceMillis ?? trade.priceCents * 10) * 10;
          acc.buyAmountCents += Math.round((priceTenThousandths * trade.quantity) / 100) + trade.feeCents;
        } else {
          acc.sellCount += 1;
          acc.sellQuantity += trade.quantity;
        }
        return acc;
      },
      {
        symbol,
        name: list[0]?.name ?? symbol,
        buyCount: 0,
        buyQuantity: 0,
        buyAmountCents: 0,
        sellCount: 0,
        sellQuantity: 0,
        currentPosition: 0,
        realizedCents: 0,
      },
    );
    const portfolio = calculatePortfolio(list);
    summary.currentPosition = portfolio.positions[0]?.quantity ?? 0;
    summary.realizedCents = portfolio.realizedCents;
    stats.push(summary);
  }
  return stats.sort((a, b) => b.buyCount - a.buyCount || b.buyAmountCents - a.buyAmountCents);
}

export function calculateTradeStatistics(
  trades: Trade[],
  capitalFlows: CapitalFlow[],
  reviews: ReviewInput[],
  initialCapitalCents: number | null = null,
): TradeStatistics {
  const cycles = buildTradeCycles(trades).filter((cycle) => cycle.endTradeId !== null && cycle.endDate !== null);
  const realized = cycles.map((cycle) => ({
    symbol: cycle.symbol,
    name: cycle.name,
    realizedCents: cycle.realizedCents,
    start: cycle.startDate,
    end: cycle.endDate!,
    days: daysBetween(cycle.startDate, cycle.endDate!),
  }));

  const totalTrades = realized.length;
  const winning = realized.filter((item) => item.realizedCents > 0);
  const losing = realized.filter((item) => item.realizedCents < 0);
  const scratch = realized.filter((item) => item.realizedCents === 0);
  const grossProfitCents = winning.reduce((sum, item) => sum + item.realizedCents, 0);
  const grossLossCents = Math.abs(losing.reduce((sum, item) => sum + item.realizedCents, 0));
  const totalRealizedCents = grossProfitCents - grossLossCents;
  const profitFactor = grossLossCents === 0 ? (grossProfitCents > 0 ? Infinity : 0) : safeDivide(grossProfitCents, grossLossCents);
  const winRate = safeDivide(winning.length, winning.length + losing.length);
  const avgWinCents = safeDivide(grossProfitCents, winning.length);
  const avgLossCents = safeDivide(grossLossCents, losing.length);
  const expectancyCents = safeDivide(totalRealizedCents, totalTrades);
  const holdingDays = realized.map((item) => item.days);
  const avgHoldingDays = safeDivide(holdingDays.reduce((sum, value) => sum + value, 0), holdingDays.length);
  const maxHoldingDays = holdingDays.length ? Math.max(...holdingDays) : 0;
  const bestTradeCents = realized.length ? Math.max(...realized.map((item) => item.realizedCents)) : 0;
  const worstTradeCents = realized.length ? Math.min(...realized.map((item) => item.realizedCents)) : 0;

  const sortedByEnd = [...realized].sort((a, b) => (a.end < b.end ? -1 : a.end > b.end ? 1 : 0));
  let currentWinStreak = 0;
  let longestWinStreak = 0;
  let currentLossStreak = 0;
  let longestLossStreak = 0;
  let runningWin = 0;
  let runningLoss = 0;
  for (const item of sortedByEnd) {
    if (item.realizedCents > 0) {
      runningWin += 1;
      runningLoss = 0;
      longestWinStreak = Math.max(longestWinStreak, runningWin);
    } else if (item.realizedCents < 0) {
      runningLoss += 1;
      runningWin = 0;
      longestLossStreak = Math.max(longestLossStreak, runningLoss);
    }
  }
  const lastTrade = sortedByEnd[sortedByEnd.length - 1];
  if (lastTrade) {
    if (lastTrade.realizedCents > 0) currentWinStreak = runningWin;
    else if (lastTrade.realizedCents < 0) currentLossStreak = runningLoss;
  }

  const byMonthMap = new Map<string, { realizedCents: number; trades: number; wins: number }>();
  for (const item of realized) {
    const key = monthKey(item.end);
    const entry = byMonthMap.get(key) ?? { realizedCents: 0, trades: 0, wins: 0 };
    entry.realizedCents += item.realizedCents;
    entry.trades += 1;
    if (item.realizedCents > 0) entry.wins += 1;
    byMonthMap.set(key, entry);
  }
  const byMonth: MonthlyStat[] = [...byMonthMap.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([month, entry]) => ({
      month,
      realizedCents: entry.realizedCents,
      trades: entry.trades,
      winRate: safeDivide(entry.wins, entry.trades),
    }));

  const bySymbolMap = new Map<string, { name: string; realizedCents: number; trades: number; wins: number }>();
  for (const item of realized) {
    const entry = bySymbolMap.get(item.symbol) ?? { name: item.name, realizedCents: 0, trades: 0, wins: 0 };
    entry.realizedCents += item.realizedCents;
    entry.trades += 1;
    if (item.realizedCents > 0) entry.wins += 1;
    bySymbolMap.set(item.symbol, entry);
  }
  const bySymbol: SymbolStat[] = [...bySymbolMap.entries()]
    .map(([symbol, entry]) => ({
      symbol,
      name: entry.name,
      realizedCents: entry.realizedCents,
      trades: entry.trades,
      winRate: safeDivide(entry.wins, entry.trades),
    }))
    .sort((a, b) => b.realizedCents - a.realizedCents);

  const byTagMap = new Map<string, { reviews: number; realizedCents: number; wins: number }>();
  for (const review of reviews) {
    if (!review.tags.length) continue;
    const value = review.resultCents ?? 0;
    for (const tag of review.tags) {
      const entry = byTagMap.get(tag) ?? { reviews: 0, realizedCents: 0, wins: 0 };
      entry.reviews += 1;
      entry.realizedCents += value;
      if (value > 0) entry.wins += 1;
      byTagMap.set(tag, entry);
    }
  }
  const byTag: TagStat[] = [...byTagMap.entries()]
    .map(([tag, entry]) => ({
      tag,
      reviews: entry.reviews,
      realizedCents: entry.realizedCents,
      winRate: safeDivide(entry.wins, entry.reviews),
    }))
    .sort((a, b) => b.realizedCents - a.realizedCents);

  // 按买入理由归因：取每笔已清仓周期中第一笔买入（建仓）的 reason，
  // 理由在买入时就已记录，无需等复盘即可归因。
  const byReasonMap = new Map<string, { trades: number; realizedCents: number; wins: number }>();
  for (const cycle of cycles) {
    const reason = cycle.trades.find((trade) => trade.side === "买入")?.reason ?? "";
    if (!reason) continue;
    const entry = byReasonMap.get(reason) ?? { trades: 0, realizedCents: 0, wins: 0 };
    entry.trades += 1;
    entry.realizedCents += cycle.realizedCents;
    if (cycle.realizedCents > 0) entry.wins += 1;
    byReasonMap.set(reason, entry);
  }
  const byReason: ReasonStat[] = [...byReasonMap.entries()]
    .map(([reason, entry]) => ({
      reason,
      trades: entry.trades,
      realizedCents: entry.realizedCents,
      winRate: safeDivide(entry.wins, entry.trades),
    }))
    .sort((a, b) => b.realizedCents - a.realizedCents);

  // 按卖出理由归因：取每笔已清仓周期中「清仓那一笔卖出」的 reason，
  // 回答「纪律卖（止盈/止损）赚还是亏，情绪卖（怕回吐/拿不住）亏多少」。
  // endTradeId 对应清仓卖出；老数据缺失时回退到周期内最后一笔卖出。
  const bySellReasonMap = new Map<string, { trades: number; realizedCents: number; wins: number }>();
  for (const cycle of cycles) {
    const closingSell =
      cycle.trades.find((trade) => cycle.endTradeId !== null && trade.id === cycle.endTradeId) ??
      [...cycle.trades].reverse().find((trade) => trade.side === "卖出");
    const reason = closingSell?.reason ?? "";
    if (!reason) continue;
    const entry = bySellReasonMap.get(reason) ?? { trades: 0, realizedCents: 0, wins: 0 };
    entry.trades += 1;
    entry.realizedCents += cycle.realizedCents;
    if (cycle.realizedCents > 0) entry.wins += 1;
    bySellReasonMap.set(reason, entry);
  }
  const bySellReason: ReasonStat[] = [...bySellReasonMap.entries()]
    .map(([reason, entry]) => ({
      reason,
      trades: entry.trades,
      realizedCents: entry.realizedCents,
      winRate: safeDivide(entry.wins, entry.trades),
    }))
    .sort((a, b) => b.realizedCents - a.realizedCents);

  const events: Array<{ date: string; delta: number }> = [
    ...capitalFlows.map((flow) => ({ date: flow.flowDate, delta: flow.amountCents })),
    ...realized.map((item) => ({ date: item.end, delta: item.realizedCents })),
  ].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const startEquity = initialCapitalCents ?? 0;
  let equity = startEquity;
  let peak = startEquity;
  let maxDrawdownCents = 0;
  const equityCurve: EquityPoint[] = [{ date: "起点", equityCents: startEquity }];
  for (const event of events) {
    equity += event.delta;
    if (equity > peak) peak = equity;
    const drawdown = peak - equity;
    if (drawdown > maxDrawdownCents) maxDrawdownCents = drawdown;
    equityCurve.push({ date: event.date, equityCents: equity });
  }
  const maxDrawdownPercent = safeDivide(maxDrawdownCents, peak === 0 ? 1 : peak) * 100;

  const planFollowed = reviews.filter((review) => review.followedPlan);
  const planDeviated = reviews.filter((review) => !review.followedPlan);
  const planAdherence: PlanAdherence = {
    total: reviews.length,
    followed: planFollowed.length,
    rate: safeDivide(planFollowed.length, reviews.length),
    followedRealizedCents: planFollowed.reduce((sum, review) => sum + (review.resultCents ?? 0), 0),
    deviatedRealizedCents: planDeviated.reduce((sum, review) => sum + (review.resultCents ?? 0), 0),
    followedWinRate: safeDivide(
      planFollowed.filter((review) => (review.resultCents ?? 0) > 0).length,
      planFollowed.length,
    ),
    deviatedWinRate: safeDivide(
      planDeviated.filter((review) => (review.resultCents ?? 0) > 0).length,
      planDeviated.length,
    ),
  };

  return {
    totalTrades,
    realizedCents: totalRealizedCents,
    grossProfitCents,
    grossLossCents,
    winningTrades: winning.length,
    losingTrades: losing.length,
    scratchTrades: scratch.length,
    winRate,
    profitFactor,
    expectancyCents,
    avgWinCents,
    avgLossCents,
    avgHoldingDays,
    maxHoldingDays,
    maxDrawdownCents,
    maxDrawdownPercent,
    bestTradeCents,
    worstTradeCents,
    currentWinStreak,
    longestWinStreak,
    currentLossStreak,
    longestLossStreak,
    byMonth,
    bySymbol,
    byTag,
    byReason,
    bySellReason,
    equityCurve,
    planAdherence,
  };
}
