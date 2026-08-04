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

export type TagStat = {
  tag: string;
  reviews: number;
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
    equityCurve,
    planAdherence,
  };
}
