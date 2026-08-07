import { isIsoDate } from "../domain/domain";
import { shanghaiIso } from "../utils/time";
import { getMairuiSectorMoves } from "./mairui";

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
  basis: "etf-proxy" | "eastmoney-board" | "mairui-board";
  source: {
    name: string;
    url: string;
    fetchedAt: string;
  };
  /** 实际使用的交易日。与请求日期不同时说明发生了回退（盘前/非交易日）。 */
  effectiveDate?: string;
  /** 回退说明；为空表示数据就是请求当日产出的。 */
  note?: string;
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

async function loadSectorMove(
  proxy: IndustryProxy,
  date: string,
): Promise<{ move: SectorMove | null; maxDate: string | null }> {
  try {
    const response = await fetch(
      `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${proxy.symbol},day,,,800,qfq`,
      {
        headers: { "user-agent": "Mozilla/5.0 StockReviewAssistant/1.0" },
        signal: AbortSignal.timeout(8_000),
      },
    );
    if (!response.ok) return { move: null, maxDate: null };
    const payload = await response.json() as TencentKlineResponse;
    const rows = payload.data?.[proxy.symbol]?.qfqday ?? payload.data?.[proxy.symbol]?.day ?? [];
    let maxDate: string | null = null;
    for (const row of rows) {
      const d = row[0];
      if (typeof d === "string" && (!maxDate || d > maxDate)) maxDate = d;
    }
    return { move: parseEtfKlines(proxy, rows, date), maxDate };
  } catch {
    return { move: null, maxDate: null };
  }
}

async function loadSectorMoves(date: string): Promise<{ moves: SectorMove[]; latestDate: string | null }> {
  const moves: SectorMove[] = [];
  let latestDate: string | null = null;
  for (let index = 0; index < INDUSTRY_PROXIES.length; index += 4) {
    const batch = await Promise.all(
      INDUSTRY_PROXIES.slice(index, index + 4).map((proxy) => loadSectorMove(proxy, date)),
    );
    for (const result of batch) {
      if (result.move) moves.push(result.move);
      if (result.maxDate && (!latestDate || result.maxDate > latestDate)) latestDate = result.maxDate;
    }
  }
  return { moves, latestDate };
}

export async function getSectorHeatmap(date: string, limit = 10): Promise<SectorHeatmap> {
  const validationError = validateSectorDate(date);
  if (validationError) throw new Error(validationError);

  // 主源(腾讯行业ETF代理)按请求日期取数；同时记录可取到的最近交易日。
  const primary = await loadSectorMoves(date);
  let moves = primary.moves;
  const latestDate = primary.latestDate;
  let basis: SectorHeatmap["basis"] = "etf-proxy";
  let source = { name: "腾讯证券行业主题ETF行情", url: SOURCE_URL, fetchedAt: shanghaiIso() };
  let effectiveDate = date;
  let note: string | undefined;

  // 主源对请求日期无数据（盘前/盘中未收盘/非交易日/周末）→ 回退到最近有数据的真实交易日，
  // 清晰标注，避免返回 503 或把旧数据伪装成当日数据。
  if (moves.length < 5 && latestDate && latestDate < date) {
    effectiveDate = latestDate;
    const retry = await loadSectorMoves(effectiveDate);
    if (retry.moves.length >= 5) {
      moves = retry.moves;
      note = `「${date}」行情尚未产生，已展示最近交易日 ${effectiveDate} 的板块表现`;
    }
  }

  // 二级兜底：东方财富板块涨幅榜（实时/最近收盘，不保证与历史 date 完全一致）。
  if (moves.length < 5) {
    const em = await loadEastmoneySectorMoves(date);
    if (em.length >= 5) {
      moves = em;
      basis = "eastmoney-board";
      source = { name: "东方财富板块涨幅榜", url: "https://quote.eastmoney.com/center/boardlist.html", fetchedAt: shanghaiIso() };
    }
  }

  // 三级兜底：麦蕊行业板块批量接口（需配置 key）。
  if (moves.length < 5) {
    const mr = await loadMairuiSectorMoves(date);
    if (mr.length >= 5) {
      moves = mr;
      basis = "mairui-board";
      source = { name: "麦蕊智数行业板块", url: "https://www.mairuiapi.com/", fetchedAt: shanghaiIso() };
    }
  }

  if (moves.length < 5) {
    throw new Error("该日期可能是非交易日，或备用行情源暂时不可用");
  }

  return {
    date: effectiveDate,
    sectors: rankSectorMoves(moves, limit),
    sampleSize: moves.length,
    basis,
    source,
    effectiveDate,
    note,
  };
}

// 二级数据源：东方财富板块涨幅榜（行业 + 概念）。一次性批量拉取，零额度成本。
// 注：东财板块榜为实时/最近收盘数据，不保证与历史 date 完全一致；大屏主看当天，回退可接受。
async function loadEastmoneySectorMoves(date: string): Promise<SectorMove[]> {
  try {
    const fsList = ["m:90+t:2", "m:90+t:3"]; // 行业板块 + 概念板块
    const lists: Array<{ f12?: string; f14?: string; f3?: number }> = [];
    await Promise.all(
      fsList.map(async (fs) => {
        const url = `https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=100&po=1&np=1&fltt=2&invt=2&fs=${fs}&fields=f12,f14,f3&_=${Date.now()}`;
        try {
          const res = await fetch(url, {
            headers: { "user-agent": "Mozilla/5.0", Referer: "https://quote.eastmoney.com/" },
            signal: AbortSignal.timeout(8_000),
          });
          if (!res.ok) return;
          const json = (await res.json()) as { data?: { diff?: Array<{ f12?: string; f14?: string; f3?: number }> } };
          if (json.data?.diff) lists.push(...json.data.diff);
        } catch {
          /* 单个板块列表失败不阻断另一个 */
        }
      })
    );
    return lists
      .filter((it) => it.f14 && Number.isFinite(it.f3))
      .map((it) => ({
        code: it.f12 ?? "",
        name: it.f14 as string,
        date,
        close: 0,
        changePercent: it.f3 as number,
        amount: 0,
        amplitude: 0,
        turnover: 0,
      }));
  } catch {
    return [];
  }
}

// 三级数据源适配：麦蕊行业板块批量接口（一次调用）。字段仅 name + changePercent，其余补占位。
async function loadMairuiSectorMoves(date: string): Promise<SectorMove[]> {
  try {
    const rows = await getMairuiSectorMoves();
    if (!rows || rows.length === 0) return [];
    return rows.map((r) => ({
      code: "",
      name: r.name,
      date,
      close: 0,
      changePercent: r.changePercent,
      amount: 0,
      amplitude: 0,
      turnover: 0,
    }));
  } catch {
    return [];
  }
}
