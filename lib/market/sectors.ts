import { isIsoDate } from "../domain/domain";
import { shanghaiIso } from "../utils/time";

export type SectorMove = {
  code: string;
  name: string;
  date: string;
  close: number;
  changePercent: number;
  amount: number;
  amplitude: number;
  turnover: number;
};

export type SectorHeatmap = {
  date: string;
  sectors: SectorMove[];
  sampleSize: number;
  basis: "etf-proxy";
  source: {
    name: string;
    url: string;
    fetchedAt: string;
  };
};

type IndustryProxy = {
  code: string;
  name: string;
  symbol: string;
};

type TencentKlineResponse = {
  data?: Record<string, {
    qfqday?: string[][];
    day?: string[][];
  }>;
};

const INDUSTRY_PROXIES: IndustryProxy[] = [
  { code: "512480", name: "半导体", symbol: "sh512480" },
  { code: "515030", name: "新能源汽车", symbol: "sh515030" },
  { code: "512010", name: "医药", symbol: "sh512010" },
  { code: "512800", name: "银行", symbol: "sh512800" },
  { code: "512880", name: "证券", symbol: "sh512880" },
  { code: "512200", name: "房地产", symbol: "sh512200" },
  { code: "512660", name: "国防军工", symbol: "sh512660" },
  { code: "512980", name: "传媒", symbol: "sh512980" },
  { code: "515050", name: "通信", symbol: "sh515050" },
  { code: "512400", name: "有色金属", symbol: "sh512400" },
  { code: "515220", name: "煤炭", symbol: "sh515220" },
  { code: "515210", name: "钢铁", symbol: "sh515210" },
  { code: "159928", name: "消费", symbol: "sz159928" },
  { code: "159996", name: "家用电器", symbol: "sz159996" },
  { code: "516950", name: "基础设施", symbol: "sh516950" },
  { code: "159870", name: "基础化工", symbol: "sz159870" },
  { code: "516960", name: "机械设备", symbol: "sh516960" },
  { code: "159611", name: "电力", symbol: "sz159611" },
];

const SOURCE_URL = "https://gu.qq.com/";

function shanghaiDate() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
}

export function validateSectorDate(value: string) {
  if (!isIsoDate(value)) return "日期格式不正确";
  if (value > shanghaiDate()) return "不能查询未来日期";
  if (value < "2018-01-01") return "暂时只支持查询2018年以后的交易日";
  return null;
}

export function parseEtfKlines(proxy: IndustryProxy, rows: string[][], date: string): SectorMove | null {
  const index = rows.findIndex((row) => row[0] === date);
  if (index < 1) return null;

  const row = rows[index];
  const previous = rows[index - 1];
  const close = Number(row[2]);
  const previousClose = Number(previous[2]);
  const high = Number(row[3]);
  const low = Number(row[4]);
  const volume = Number(row[5]);
  if (![close, previousClose, high, low].every(Number.isFinite) || previousClose <= 0) return null;

  return {
    code: proxy.code,
    name: proxy.name,
    date,
    close,
    changePercent: ((close - previousClose) / previousClose) * 100,
    amount: Number.isFinite(volume) ? close * volume : 0,
    amplitude: ((high - low) / previousClose) * 100,
    turnover: 0,
  };
}

export function rankSectorMoves(moves: SectorMove[], limit = 10) {
  return [...moves]
    .sort((left, right) =>
      Math.abs(right.changePercent) - Math.abs(left.changePercent) ||
      right.amount - left.amount ||
      left.name.localeCompare(right.name, "zh-CN")
    )
    .slice(0, limit);
}

async function loadSectorMove(proxy: IndustryProxy, date: string) {
  try {
    const response = await fetch(
      `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${proxy.symbol},day,,,800,qfq`,
      {
        headers: { "user-agent": "Mozilla/5.0 StockReviewAssistant/1.0" },
        signal: AbortSignal.timeout(8_000),
      },
    );
    if (!response.ok) return null;
    const payload = await response.json() as TencentKlineResponse;
    const rows = payload.data?.[proxy.symbol]?.qfqday ?? payload.data?.[proxy.symbol]?.day ?? [];
    return parseEtfKlines(proxy, rows, date);
  } catch {
    return null;
  }
}

async function loadSectorMoves(date: string) {
  const moves: SectorMove[] = [];
  for (let index = 0; index < INDUSTRY_PROXIES.length; index += 4) {
    const batch = await Promise.all(
      INDUSTRY_PROXIES.slice(index, index + 4).map((proxy) => loadSectorMove(proxy, date)),
    );
    moves.push(...batch.filter((move): move is SectorMove => move !== null));
  }
  return moves;
}

export async function getSectorHeatmap(date: string, limit = 10): Promise<SectorHeatmap> {
  const validationError = validateSectorDate(date);
  if (validationError) throw new Error(validationError);

  const moves = await loadSectorMoves(date);
  if (moves.length < 5) {
    throw new Error("该日期可能是非交易日，或备用行情源暂时不可用");
  }

  return {
    date,
    sectors: rankSectorMoves(moves, limit),
    sampleSize: moves.length,
    basis: "etf-proxy",
    source: {
      name: "腾讯证券行业主题ETF行情",
      url: SOURCE_URL,
      fetchedAt: shanghaiIso(),
    },
  };
}
