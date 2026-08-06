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

  for (const position of positions) {
    position.allocationPercent = totalAssetsCents && totalAssetsCents > 0
      ? position.marketValueCents / totalAssetsCents * 100
      : marketValueCents > 0
        ? position.marketValueCents / marketValueCents * 100
        : null;
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
    totalProfitPercent: totalProfitCents === null || !adjustedBase
      ? null
      : totalProfitCents / adjustedBase * 100,
    totalDepositCents,
    totalWithdrawalCents,
    netFlowCents,
    positions,
    history,
  };
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
