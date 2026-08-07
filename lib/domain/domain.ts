import { shanghaiDate } from "../utils/time";

export type Trade = {
  id: number;
  symbol: string;
  name: string;
  side: "买入" | "卖出";
  priceCents: number;
  priceMillis?: number | null;
  priceTenThousandths?: number | null;
  quantity: number;
  tradeDate: string;
  reason: string;
  maxLossCents: number | null;
  feeCents: number;
  otherReason?: string | null;
  createdAt?: string;
  /** 最后修改时间（PATCH 时更新）；DB 列 trade_records.updated_at（ensureSchema 运行时加列） */
  updatedAt?: string | null;
};

export type Position = {
  symbol: string;
  name: string;
  quantity: number;
  costCents: number;
  costMillis: number;
  costTenThousandths: number;
  averageCostCents: number;
  averageCostMillis: number;
  averageCostTenThousandths: number;
  legacyPrecision: boolean;
};

export type PortfolioSummary = {
  positions: Position[];
  realizedCents: number;
  winningSells: number;
  losingSells: number;
};

export type TradeCycle = {
  symbol: string;
  name: string;
  trades: Trade[];
  startTradeId: number;
  endTradeId: number | null;
  startDate: string;
  endDate: string | null;
  realizedCents: number;
};

export type InvalidSell = {
  symbol: string;
  availableQuantity: number;
  requestedQuantity: number;
};

export type CapitalFlow = {
  id: number;
  amountCents: number;
  flowDate: string;
  note: string | null;
  createdAt: string;
};

export type MarketPeriod = "day" | "week" | "month";
/** 分时（分钟K线）周期档位，与 /api/kline?period= 一致。 */
export type IntradayPeriod = "5m" | "15m" | "30m" | "60m" | "dn";
/** 图表周期联合类型（日/周/月 + 分时）。 */
export type ChartPeriod = MarketPeriod | IntradayPeriod;
/** 判断是否为分时周期。 */
export function isIntradayPeriod(p: ChartPeriod): p is IntradayPeriod {
  return p === "5m" || p === "15m" || p === "30m" || p === "60m" || p === "dn";
}

export type MarketBar = {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  ma5: number | null;
  ma20: number | null;
  ma60: number | null;
};

function orderedTrades(trades: Trade[]) {
  return [...trades].sort((a, b) => {
    const dateOrder = a.tradeDate.localeCompare(b.tradeDate);
    return dateOrder || a.id - b.id;
  });
}

export function calculatePortfolio(trades: Trade[]): PortfolioSummary {
  const positions = new Map<string, Position>();
  let realizedMillis = 0;
  let winningSells = 0;
  let losingSells = 0;

  for (const trade of orderedTrades(trades)) {
    const current = positions.get(trade.symbol) ?? {
      symbol: trade.symbol,
      name: trade.name,
      quantity: 0,
      costCents: 0,
      costMillis: 0,
      costTenThousandths: 0,
      averageCostCents: 0,
      averageCostMillis: 0,
      averageCostTenThousandths: 0,
      legacyPrecision: false,
    };
    const priceTenThousandths =
      trade.priceTenThousandths ?? (trade.priceMillis ?? trade.priceCents * 10) * 10;
    current.legacyPrecision ||= trade.priceMillis === null && trade.priceTenThousandths === null;

    if (trade.side === "买入") {
      current.quantity += trade.quantity;
      current.costTenThousandths += priceTenThousandths * trade.quantity + trade.feeCents * 100;
      current.costMillis = Math.round(current.costTenThousandths / 10);
      current.costCents = Math.round(current.costTenThousandths / 100);
      current.averageCostTenThousandths = Math.round(current.costTenThousandths / current.quantity);
      current.averageCostMillis = Math.round(current.averageCostTenThousandths / 10);
      current.averageCostCents = Math.round(current.averageCostTenThousandths / 100);
      positions.set(trade.symbol, current);
      continue;
    }

    const soldQuantity = Math.min(trade.quantity, current.quantity);
    if (soldQuantity <= 0) {
      continue;
    }

    const saleProfitTenThousandths =
      priceTenThousandths * soldQuantity -
      current.averageCostTenThousandths * soldQuantity -
      trade.feeCents * 100;
    realizedMillis += saleProfitTenThousandths / 10;
    if (saleProfitTenThousandths > 0) winningSells += 1;
    if (saleProfitTenThousandths < 0) losingSells += 1;

    current.quantity -= soldQuantity;
    current.costTenThousandths = current.quantity > 0
      ? Math.max(0, current.costTenThousandths - current.averageCostTenThousandths * soldQuantity)
      : 0;
    current.costMillis = Math.round(current.costTenThousandths / 10);
    current.costCents = Math.round(current.costTenThousandths / 100);
    current.averageCostTenThousandths = current.quantity > 0
      ? Math.round(current.costTenThousandths / current.quantity)
      : 0;
    current.averageCostMillis = Math.round(current.averageCostTenThousandths / 10);
    current.averageCostCents = Math.round(current.averageCostTenThousandths / 100);
    positions.set(trade.symbol, current);
  }

  return {
    positions: [...positions.values()].filter((position) => position.quantity > 0),
    realizedCents: Math.round(realizedMillis / 10),
    winningSells,
    losingSells,
  };
}

export function findInvalidSell(trades: Trade[]): InvalidSell | null {
  const quantities = new Map<string, number>();

  for (const trade of orderedTrades(trades)) {
    const availableQuantity = quantities.get(trade.symbol) ?? 0;
    if (trade.side === "卖出") {
      if (trade.quantity > availableQuantity) {
        return {
          symbol: trade.symbol,
          availableQuantity,
          requestedQuantity: trade.quantity,
        };
      }
      quantities.set(trade.symbol, availableQuantity - trade.quantity);
      continue;
    }
    quantities.set(trade.symbol, availableQuantity + trade.quantity);
  }

  return null;
}

// 直接基于单个周期的 trades 计算已实现盈亏（分），避免对子数组再跑 calculatePortfolio
// （其内部会重新整排序 + 重建全市场 positions Map，导致 buildTradeCycles 退化为 O(n²)）。
function calculateCycleRealized(cycleTrades: Trade[]): number {
  const positions = new Map<string, { quantity: number; avgTenThousandths: number }>();
  let realizedMillis = 0;

  for (const trade of cycleTrades) {
    const priceTenThousandths =
      trade.priceTenThousandths ?? (trade.priceMillis ?? trade.priceCents * 10) * 10;
    const pos = positions.get(trade.symbol) ?? { quantity: 0, avgTenThousandths: 0 };

    if (trade.side === "买入") {
      const totalCost = pos.avgTenThousandths * pos.quantity + priceTenThousandths * trade.quantity + trade.feeCents * 100;
      pos.quantity += trade.quantity;
      pos.avgTenThousandths = pos.quantity > 0 ? Math.round(totalCost / pos.quantity) : 0;
      positions.set(trade.symbol, pos);
      continue;
    }

    const soldQuantity = Math.min(trade.quantity, pos.quantity);
    if (soldQuantity <= 0) continue;
    const profit = priceTenThousandths * soldQuantity - pos.avgTenThousandths * soldQuantity - trade.feeCents * 100;
    realizedMillis += profit / 10;
    pos.quantity -= soldQuantity;
    positions.set(trade.symbol, pos);
  }

  return Math.round(realizedMillis / 10);
}

export function buildTradeCycles(trades: Trade[]): TradeCycle[] {
  const cycles: TradeCycle[] = [];
  const open = new Map<string, { quantity: number; trades: Trade[] }>();

  for (const trade of orderedTrades(trades)) {
    if (trade.side === "买入") {
      const current = open.get(trade.symbol) ?? { quantity: 0, trades: [] };
      current.quantity += trade.quantity;
      current.trades.push(trade);
      open.set(trade.symbol, current);
      continue;
    }

    const current = open.get(trade.symbol);
    if (!current || current.quantity <= 0) continue;
    current.trades.push(trade);
    current.quantity = Math.max(0, current.quantity - trade.quantity);
    if (current.quantity > 0) continue;

    cycles.push({
      symbol: trade.symbol,
      name: trade.name,
      trades: current.trades,
      startTradeId: current.trades[0].id,
      endTradeId: trade.id,
      startDate: current.trades[0].tradeDate,
      endDate: trade.tradeDate,
      realizedCents: calculateCycleRealized(current.trades),
    });
    open.delete(trade.symbol);
  }

  for (const current of open.values()) {
    const first = current.trades[0];
    cycles.push({
      symbol: first.symbol,
      name: first.name,
      trades: current.trades,
      startTradeId: first.id,
      endTradeId: null,
      startDate: first.tradeDate,
      endDate: null,
      realizedCents: calculateCycleRealized(current.trades),
    });
  }

  return cycles.sort((a, b) => a.startDate.localeCompare(b.startDate) || a.startTradeId - b.startTradeId);
}

export function localIsoDate(date = new Date()) {
  return shanghaiDate(date);
}

export function toCents(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 100) : 0;
}

export function toMillis(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 1000) : 0;
}

export function toTenThousandths(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 10_000) : 0;
}

export function isStockCode(value: string) {
  return /^\d{6}$/.test(value.trim());
}

export function isTradeSide(value: unknown): value is "买入" | "卖出" {
  return value === "买入" || value === "卖出";
}

export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function aggregateMarketHistory(
  history: Array<Pick<MarketBar, "date" | "open" | "high" | "low" | "close" | "volume">>,
  period: MarketPeriod,
): MarketBar[] {
  const grouped: Array<Omit<MarketBar, "ma5" | "ma20" | "ma60">> = [];
  let lastKey = "";

  for (const row of history) {
    let key = row.date;
    let labelDate = row.date;
    if (period === "month") {
      key = row.date.slice(0, 7);
      labelDate = `${key}-01`;
    } else if (period === "week") {
      const monday = new Date(`${row.date}T00:00:00Z`);
      const weekday = monday.getUTCDay() || 7;
      monday.setUTCDate(monday.getUTCDate() - weekday + 1);
      key = monday.toISOString().slice(0, 10);
      labelDate = key;
    }

    const current = grouped.at(-1);
    if (period === "day" || key !== lastKey || !current) {
      grouped.push({
        date: labelDate,
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        volume: row.volume,
      });
      lastKey = key;
      continue;
    }

    current.high = Math.max(current.high, row.high);
    current.low = Math.min(current.low, row.low);
    current.close = row.close;
    current.volume += row.volume;
    if (period === "week") {
      current.date = row.date;
    }
  }

  const closes = grouped.map((row) => row.close);
  // 增量滑动窗口前缀和：避免每次对 closes.slice().reduce()，将 O(n×85) 降为 O(n)。
  const prefixSum: number[] = new Array(closes.length + 1).fill(0);
  for (let i = 0; i < closes.length; i++) {
    prefixSum[i + 1] = prefixSum[i] + closes[i];
  }
  const movingAverage = (index: number, window: number) => {
    if (index + 1 < window) return null;
    const sum = prefixSum[index + 1] - prefixSum[index + 1 - window];
    return sum / window;
  };

  return grouped.map((row, index) => ({
    ...row,
    ma5: movingAverage(index, 5),
    ma20: movingAverage(index, 20),
    ma60: movingAverage(index, 60),
  }));
}
