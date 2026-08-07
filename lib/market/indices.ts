// 主要大盘指数实时行情。
// 优先源：麦蕊智数（/hsindex，原生 A 股指数，配置 MAIRUI_TOKEN 时启用）。
// 降级源：腾讯证券 qt.gtimg.cn（国内网络稳定可达，与个股行情同源）。
// 注：东方财富 push2 在部分网络环境下被掐（TLS 建连后 HTTP 超时），故不再作为主源。
import { shanghaiIso } from "../utils/time";
import { getMairuiIndices, isMairuiEnabled } from "./mairui";

export type IndexQuote = {
  code: string;
  name: string;
  price: number;
  changePercent: number;
  change: number;
};

export type IndicesData = {
  indices: IndexQuote[];
  source: { name: string; url: string; fetchedAt: string };
};

// 腾讯指数代码前缀：上证 sh、深证/创业板 sz、北证 bj。
export const MAJOR_INDICES: Array<{ code: string; tencent: string; name: string }> = [
  { code: "000001", tencent: "sh000001", name: "上证指数" },
  { code: "399001", tencent: "sz399001", name: "深证成指" },
  { code: "399006", tencent: "sz399006", name: "创业板指" },
  { code: "000300", tencent: "sh000300", name: "沪深300" },
  { code: "000688", tencent: "sh000688", name: "科创50" },
  { code: "000016", tencent: "sh000016", name: "上证50" },
  { code: "000905", tencent: "sh000905", name: "中证500" },
  { code: "000852", tencent: "sh000852", name: "中证1000" },
  { code: "899050", tencent: "bj899050", name: "北证50" },
];

const numOrNull = (v: string): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export async function getIndexQuotes(): Promise<IndicesData> {
  // 优先麦蕊：配置 token 且未熔断时优先使用，失败再降级腾讯。
  if (await isMairuiEnabled()) {
    const mairuiIndices = await getMairuiIndices();
    if (mairuiIndices && mairuiIndices.length > 0) {
      return {
        indices: mairuiIndices,
        source: {
          name: "麦蕊智数(优先) + 腾讯证券兜底",
          url: "https://www.mairuiapi.com/",
          fetchedAt: shanghaiIso(),
        },
      };
    }
  }

  const symbols = MAJOR_INDICES.map((item) => item.tencent).join(",");
  const url = `https://qt.gtimg.cn/q=${symbols}`;
  const response = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0 StockReviewAssistant/1.0" },
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) {
    throw new Error(`数据源返回 ${response.status}`);
  }
  const text = await response.text();
  const lines = text.split(";").filter((line) => line.includes("="));
  const bySymbol = new Map<string, string>();
  for (const line of lines) {
    const m = line.match(/v_(\w+)="([^"]*)"/);
    if (m) bySymbol.set(m[1], m[2]);
  }
  const indices: IndexQuote[] = [];
  for (const meta of MAJOR_INDICES) {
    const raw = bySymbol.get(meta.tencent);
    if (!raw) continue;
    const parts = raw.split("~");
    const price = numOrNull(parts[3]);
    if (price === null || price <= 0) continue;
    const change = numOrNull(parts[31]) ?? 0;
    const changePercent = numOrNull(parts[32]) ?? 0;
    indices.push({
      code: meta.code,
      name: meta.name,
      price,
      changePercent,
      change,
    });
  }
  return {
    indices,
    source: {
      name: "腾讯证券公开行情",
      url: "https://gu.qq.com/",
      fetchedAt: shanghaiIso(),
    },
  };
}
