import { calculatePortfolio, type CapitalFlow, type Trade } from "./domain";

export type PriceHistory = Record<string, Array<{ date: string; close: number }>>;

export type PortfolioInsights = {
  configured: boolean;
  completePrices: boolean;
  initialCapitalCents: number | null;
  cashCents: number | null;
  marketValueCents: number;
  totalAssetsCents: number | null;
  totalPositionPercent: number | null;
  unrealizedCents: number;
  realizedCents: number;
  totalProfitCents: number | null;
  totalProfitPercent: number | null;
  /** 收益率不可计算时的可读原因（基准过小/为负/未设置初始资金），供前端与 AI 注入使用 */
  profitPercentNote: string | null;
  totalDepositCents: number;
  totalWithdrawalCents: number;
  netFlowCents: number;
  positions: Array<{
    symbol: string;
    name: string;
    marketValueCents: number;
    unrealizedCents: number;
    returnPercent: number;
    allocationPercent: number | null;
    /** 单股占比不可计算时的可读原因（基准失真），供前端与 AI 注入使用 */
    allocationPercentNote: string | null;
  }>;
  history: Array<{
    date: string;
    totalAssetsCents: number;
    positionPercent: number;
  }>;
};

function tradeValueCents(trade: Trade) {
  const priceTenThousandths =
    trade.priceTenThousandths ?? (trade.priceMillis ?? trade.priceCents * 10) * 10;
  return Math.round(priceTenThousandths * trade.quantity / 100);
}

export function calculatePortfolioInsights(
  trades: Trade[],
  currentPrices: Record<string, number>,
  histories: PriceHistory,
  initialCapitalCents: number | null,
  capitalFlows: CapitalFlow[] = [],
): PortfolioInsights {
  // 一次遍历完成存/取汇总，避免两次 filter + 两次 reduce。
  let totalDepositCents = 0;
  let totalWithdrawalCents = 0;
  for (const f of capitalFlows) {
    if (f.amountCents > 0) totalDepositCents += f.amountCents;
    else if (f.amountCents < 0) totalWithdrawalCents += Math.abs(f.amountCents);
  }
  const netFlowCents = totalDepositCents - totalWithdrawalCents;

  const portfolio = calculatePortfolio(trades);
  const completePrices = portfolio.positions.every((position) => Number.isFinite(currentPrices[position.symbol]));
  const positions: PortfolioInsights["positions"] = portfolio.positions.map((position) => {
    const currentPrice = currentPrices[position.symbol] ?? position.averageCostTenThousandths / 10_000;
    const marketValueCents = Math.round(currentPrice * 100 * position.quantity);
    const costCents = Math.round(position.costTenThousandths / 100);
    return {
      symbol: position.symbol,
      name: position.name,
      marketValueCents,
      unrealizedCents: marketValueCents - costCents,
      returnPercent: costCents ? ((marketValueCents / costCents) - 1) * 100 : 0,
      allocationPercent: null,
      allocationPercentNote: null,
    };
  });
  const marketValueCents = positions.reduce((sum, position) => sum + position.marketValueCents, 0);
  const unrealizedCents = positions.reduce((sum, position) => sum + position.unrealizedCents, 0);
  const cashCents = initialCapitalCents === null
    ? null
    : trades.reduce((cash, trade) => (
        trade.side === "买入"
          ? cash - tradeValueCents(trade) - trade.feeCents
          : cash + tradeValueCents(trade) - trade.feeCents
      ), initialCapitalCents + netFlowCents);
  const totalAssetsCents = cashCents === null ? null : cashCents + marketValueCents;

  // 单股占比上限保护：物理上限 100%（单股市值不可能超过总资产）。
  // 若初始资金被误设导致分母（总资产）失真，单股占比会算出 >100% 的爆炸值
  // （如 5000分初始资金下可算出 585%，更极端会出 2010%）。任何 >100% 都说明
  // 分母失真，视为基准失真置 null，由前端/AI 走“无法计算”分支而非展示爆炸值。
  for (const position of positions) {
    // 分母优先用总资产（已含现金+市值）；仅在 totalAssets 不可用时退化为“持仓内部占比”。
    // 总资产非正（含大额出金压穿基准）时，分母失真，单股占比直接视为无法计算 → null。
    const raw = totalAssetsCents && totalAssetsCents > 0
      ? position.marketValueCents / totalAssetsCents * 100
      : null;
    // 单股占比：先按 safePercent 做分母保护（分母非正/非有限/超 1000% 置 null），
    // 再夹取 100% 上限——任何 >100% 都属分母失真，强制置 null，杜绝 2010% 类幻觉来源。
    const safe = safePercent(position.marketValueCents, totalAssetsCents && totalAssetsCents > 0 ? totalAssetsCents : null);
    position.allocationPercent = safe !== null
      ? (Math.abs(safe) > 100 ? null : safe)
      : (raw !== null && Math.abs(raw) > 100 ? null : raw);
    position.allocationPercentNote = safePercentNote(position.marketValueCents, totalAssetsCents && totalAssetsCents > 0 ? totalAssetsCents : null)
      ?? (position.allocationPercent === null ? "单股占比超过 100% 或账户总资产基准失真，无法有效计算，请检查账户初始资金/出入金设置" : null);
  }

  const history = initialCapitalCents === null
    ? []
    : buildPortfolioHistory(trades, histories, initialCapitalCents, capitalFlows);
  const adjustedBase = initialCapitalCents !== null ? initialCapitalCents + netFlowCents : null;
  const totalProfitCents = adjustedBase === null || totalAssetsCents === null
    ? null
    : totalAssetsCents - adjustedBase;

  return {
    configured: initialCapitalCents !== null,
    completePrices,
    initialCapitalCents,
    cashCents,
    marketValueCents,
    totalAssetsCents,
    totalPositionPercent: totalAssetsCents && totalAssetsCents > 0 ? marketValueCents / totalAssetsCents * 100 : null,
    unrealizedCents,
    realizedCents: portfolio.realizedCents,
    totalProfitCents,
    // 收益率分母保护：基准（初始资金+出入金）过小或为负时，百分比在数学上已无意义，
    // 强制置 null 并给出可读说明，避免 AI/前端拿到上万%的爆炸值（如 -14216%）。
    totalProfitPercent: safePercent(totalProfitCents, adjustedBase),
    profitPercentNote: safePercentNote(totalProfitCents, adjustedBase),
    totalDepositCents,
    totalWithdrawalCents,
    netFlowCents,
    positions,
    history,
  };
}

/**
 * 计算百分比收益，并对「基准失真」做保护，避免 -14216% 这类爆炸值。
 * 触发保护的两类情况：
 *  1) 基准（初始资金 + 出入金净额）非正或非有限 —— 分母无意义；
 *  2) 算出的收益率绝对值超过 MAX_SANE_PROFIT_PERCENT（1000%）——
 *     说明基准远小于当前总资产（如初始资金被误设为几元），结果已失真。
 * 命中任一时返回 null，由 safePercentNote 给出可读说明。
 */
const MAX_SANE_PROFIT_PERCENT = 1000;

function safePercent(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null) return null;
  if (!Number.isFinite(denominator) || denominator <= 0) return null;
  const percent = (numerator / denominator) * 100;
  if (!Number.isFinite(percent) || Math.abs(percent) > MAX_SANE_PROFIT_PERCENT) return null;
  return percent;
}

/** 配合 safePercent：在百分比不可计算时返回可读原因，否则返回 null。 */
function safePercentNote(numerator: number | null, denominator: number | null): string | null {
  if (numerator === null || denominator === null) {
    return "尚未设置初始资金或出入金，无法计算账户收益率";
  }
  if (!Number.isFinite(denominator) || denominator <= 0) {
    return "基准资金（初始资金 + 出入金净额）过小或为负，收益率无法有效计算，请检查账户设置";
  }
  const percent = (numerator / denominator) * 100;
  if (!Number.isFinite(percent) || Math.abs(percent) > MAX_SANE_PROFIT_PERCENT) {
    return "基准资金（初始资金 + 出入金净额）与当前总资产严重不匹配，收益率失真无法有效计算，请检查账户初始资金/出入金设置";
  }
  return null;
}

function buildPortfolioHistory(
  trades: Trade[],
  histories: PriceHistory,
  initialCapitalCents: number,
  capitalFlows: CapitalFlow[] = [],
) {
  if (!trades.length) return [];
  const orderedFlows = [...capitalFlows].sort((left, right) => left.flowDate.localeCompare(right.flowDate));
  const firstTradeDate = [...trades].sort((left, right) => left.tradeDate.localeCompare(right.tradeDate))[0].tradeDate;
  const firstFlowDate = orderedFlows.length > 0 ? orderedFlows[0].flowDate : null;
  const startDate = firstFlowDate && firstFlowDate < firstTradeDate ? firstFlowDate : firstTradeDate;
  const dates = [...new Set(Object.values(histories).flatMap((rows) => rows.map((row) => row.date)))]
    .filter((date) => date >= startDate)
    .sort()
    .slice(-180);
  const orderedTrades = [...trades].sort((left, right) =>
    left.tradeDate.localeCompare(right.tradeDate) || left.id - right.id
  );

  let cashCents = initialCapitalCents;
  let tradeIndex = 0;
  let flowIndex = 0;
  const quantities = new Map<string, number>();
  const latestPrices = new Map<string, number>();
  const historyRows = Object.fromEntries(
    Object.entries(histories).map(([symbol, rows]) => [symbol, new Map(rows.map((row) => [row.date, row.close]))]),
  );
  const points: Array<{ date: string; totalAssetsCents: number; positionPercent: number }> = [];

  for (const date of dates) {
    while (flowIndex < orderedFlows.length && orderedFlows[flowIndex].flowDate <= date) {
      cashCents += orderedFlows[flowIndex].amountCents;
      flowIndex += 1;
    }
    while (tradeIndex < orderedTrades.length && orderedTrades[tradeIndex].tradeDate <= date) {
      const trade = orderedTrades[tradeIndex];
      const direction = trade.side === "买入" ? 1 : -1;
      quantities.set(trade.symbol, Math.max(0, (quantities.get(trade.symbol) ?? 0) + direction * trade.quantity));
      cashCents += trade.side === "买入"
        ? -tradeValueCents(trade) - trade.feeCents
        : tradeValueCents(trade) - trade.feeCents;
      tradeIndex += 1;
    }
    // 只对当前有持仓的 symbol 取最新价（historyRows 已是 Map<symbol, Map<date, close>>），
    // 避免每天遍历全部 symbol 并重建 Object.entries（原 O(dates × symbols) 热点）。
    let marketValueCents = 0;
    for (const [symbol, quantity] of quantities) {
      const close = historyRows[symbol]?.get(date);
      if (close !== undefined) latestPrices.set(symbol, close);
      marketValueCents += Math.round((latestPrices.get(symbol) ?? 0) * 100 * quantity);
    }
    const totalAssetsCents = cashCents + marketValueCents;
    points.push({
      date,
      totalAssetsCents,
      positionPercent: totalAssetsCents > 0 ? marketValueCents / totalAssetsCents * 100 : 0,
    });
  }
  return points;
}
