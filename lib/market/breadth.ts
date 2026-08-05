// 全市场涨跌分布（大盘宽度）：统计沪深两市全部 A 股的上涨/下跌/平盘家数及涨停/跌停数。
// 数据源：东方财富行情中心 clist（与 lib/market/market-data.ts 同源，服务端稳定可达）。
// 策略：一次性拉取全市场股票列表（含涨跌幅 f3），按涨跌幅符号在本地计数，
// 避免依赖任何非公开字段位置，结果确定、可解释。模块级缓存 30s，降低请求频率。
import { shanghaiIso } from "../utils/time";

export type MarketBreadth = {
  /** 上涨家数 */
  up: number;
  /** 下跌家数 */
  down: number;
  /** 平盘家数 */
  flat: number;
  /** 涨停家数（涨跌幅 ≥ 9.5%，近似覆盖 10%/20% 涨跌停） */
  limitUp: number;
  /** 跌停家数（涨跌幅 ≤ -9.5%） */
  limitDown: number;
  /** 计入统计的总家数 */
  total: number;
  source: { name: string; url: string; fetchedAt: string };
};

// 沪深 A 股（含沪市/深市主板、创业板、科创板；B 股数量极小，纳入不影响分布观感）。
const FS = "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23";

let cache: { data: MarketBreadth; at: number } | null = null;
const TTL_MS = 30_000;

export async function getMarketBreadth(force = false): Promise<MarketBreadth> {
  const now = Date.now();
  if (!force && cache && now - cache.at < TTL_MS) return cache.data;

  const url =
    `https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=6000&po=1&np=1` +
    `&fltt=2&invt=2&fid=f3&fs=${FS}&fields=f12,f14,f3&_=${now}`;
  const response = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 StockReviewAssistant/1.0",
      Referer: "https://quote.eastmoney.com/",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`数据源返回 ${response.status}`);
  }
  const json = (await response.json()) as { data?: { diff?: Array<{ f3?: number }> } };
  const diff = json.data?.diff ?? [];

  let up = 0;
  let down = 0;
  let flat = 0;
  let limitUp = 0;
  let limitDown = 0;
  for (const item of diff) {
    const c = typeof item.f3 === "number" ? item.f3 : NaN;
    if (!Number.isFinite(c)) continue;
    if (c > 0) up += 1;
    else if (c < 0) down += 1;
    else flat += 1;
    if (c >= 9.5) limitUp += 1;
    else if (c <= -9.5) limitDown += 1;
  }
  const total = up + down + flat;

  const data: MarketBreadth = {
    up,
    down,
    flat,
    limitUp,
    limitDown,
    total,
    source: {
      name: "东方财富行情",
      url: "https://quote.eastmoney.com/",
      fetchedAt: shanghaiIso(),
    },
  };
  cache = { data, at: now };
  return data;
}
