/**
 * MarketDataProvider —— 统一行情数据入口（多级降级）。
 *
 * 设计目标：把"从哪取数"收敛到一处，对外只暴露 getRealtime / getKlines /
 * getProfile 等稳定接口；内部按优先级依次尝试多个【免费公开】数据源，任一成功即返回。
 *
 * 可用数据源（国内网络稳定可达者优先）：
 *   1) 腾讯证券 qt.gtimg.cn —— 主源（个股实时、PE/PB、指数；push2 被掐后的可靠替代）
 *   2) 东方财富 emweb / datacenter —— 财务主指标(ROE/毛利/净利)、行业/简介（域可达）
 *   3) 新浪财经 —— 实时行情后备
 *   4) 东方财富 push2 / push2his —— 兜底（部分网络环境被掐，TLS 建连后 HTTP 超时）
 *   5) 麦蕊（可选增强层，仅配置 token）—— ROE/净利/行业/简介等基本面深度字段
 *
 * 关于描述中另两家数据源在「本项目实际运行时」的可行性：
 *   - AKShare（_em 分支）：它本身不是数据源，只是抓取东方财富/新浪/交易所官网的公开网页接口。
 *     本项目用 fetch 直接复刻其 _em 系列底层端点（概念板块=stock_board_concept_name_em、
 *     资金流=stock_individual_fund_flow 等），等效且不依赖 Python 运行时。✅ 可用
 *   - 通达信 pytdx（直连 115.238.56.198:7709 等）：走的是二进制 TCP 私有协议，
 *     Cloudflare Workers 运行时没有可对任意主机发起原生 TCP 的能力，无法直接直连。❌ 当前运行时不可用
 *     若改在 Docker/Node 部署并起一个 Python 侧车代理，可后续把 TDX 作为更高优先级层接入；
 *     当前用腾讯/新浪代替它承担"后备实时行情"的角色。见文件底部 TDX_SUPPORTED / tdxNote。
 */

const UA = "Mozilla/5.0 (compatible; AIStock/1.0)";
const TIMEOUT = 10_000;
const REALTIME_CACHE_MS = 15_000;
const realtimeCache = new Map<string, { expiresAt: number; value: Promise<RealtimeQuote | null> | RealtimeQuote | null }>();

// 麦蕊（商业付费 API）作为「可选增强层」：仅当配置了 MAIRUI_TOKEN 时启用，
// 作为实时行情 / 基本面的更高优先级源；无 token 时自动走下方免费多级降级链。
// 启用时若失败（额度耗尽 / 网络错 / 字段缺失）一律静默降级回免费源，不影响主流程。
import { getMairuiRealtime, getMairuiFundamentals, isMairuiEnabled } from "./mairui";

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { "user-agent": UA },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function fetchText(url: string, headers: Record<string, string> = {}): Promise<string> {
  const res = await fetch(url, {
    headers: { "user-agent": UA, ...headers },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** 东方财富 secid：上交所(5/6/9 开头)=1，深交所/北交所=0 */
function eastmoneySecid(code: string): string {
  if (/^(5|6|9)/.test(code)) return `1.${code}`;
  return `0.${code}`;
}

/** 6 位代码 → 腾讯符号（如 600000→sh600000） */
export function tencentSymbol(code: string): string {
  if (/^\d{6}$/.test(code)) {
    const prefix = code.startsWith("6") || code.startsWith("9") ? "sh" : "sz";
    return `${prefix}${code}`;
  }
  return code;
}

// ---------------------------------------------------------------------------
// 对外类型
// ---------------------------------------------------------------------------

export type RealtimeQuote = {
  code: string;
  name: string | null;
  price: number;
  previousClose: number | null;
  changePercent: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  sourceName: string;
  sourceUrl: string;
};

export type KlineRow = {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type KlineResult = {
  rows: KlineRow[];
  sourceName: string;
  sourceUrl: string;
};

export type StockProfile = {
  name: string | null;
  marketCap: number | null;
  pe: number | null;
  pb: number | null;
  roe: number | null;
  grossMargin: number | null;
  profitMargin: number | null;
  operatingCashflow: number | null;
  sector: string | null;
  industry: string | null;
  businessSummary: string | null;
  /** 诊断字段：基本面资料取数失败时的具体原因（如东财接口超时/被限流），用于排查线上 PE/PB 缺失。 */
  profileError?: string | null;
};

export type FundFlow = {
  code: string;
  mainNetInflow: number | null;
  sourceName: string;
};

export type ConceptBoard = {
  code: string;
  name: string;
};

// ---------------------------------------------------------------------------
// 实时行情：东方财富 → 腾讯 → 新浪
// ---------------------------------------------------------------------------

async function eastmoneyRealtime(code: string): Promise<RealtimeQuote> {
  const secid = eastmoneySecid(code);
  const url = `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=f43,f44,f45,f46,f57,f58,f60&invt=2&fltt=2&_=${Date.now()}`;
  const data = await fetchJson<{ data?: Record<string, string | null> }>(url);
  const d = data.data;
  if (!d) throw new Error("东方财富实时无数据");
  const price = num(d.f43);
  if (price === null) throw new Error("东方财富实时价格缺失");
  const previousClose = num(d.f60);
  const changePercent = previousClose ? ((price - previousClose) / previousClose) * 100 : null;
  return {
    code,
    name: typeof d.f58 === "string" && d.f58 ? d.f58 : null,
    price,
    previousClose,
    changePercent,
    open: num(d.f46),
    high: num(d.f44),
    low: num(d.f45),
    sourceName: "东方财富实时行情",
    sourceUrl: `https://quote.eastmoney.com/${secid}.html`,
  };
}

async function tencentRealtime(code: string): Promise<RealtimeQuote> {
  const ts = tencentSymbol(code);
  const text = await fetchText(`https://qt.gtimg.cn/q=${ts}`);
  const m = text.match(/="([^"]*)"/);
  if (!m) throw new Error("腾讯实时解析失败");
  const parts = m[1].split("~");
  const price = num(parts[3]);
  if (price === null) throw new Error("腾讯实时价格缺失");
  const previousClose = num(parts[4]);
  const changePercent = num(parts[32]);
  return {
    code,
    name: parts[1] || null,
    price,
    previousClose,
    changePercent,
    open: num(parts[5]),
    high: num(parts[33]),
    low: num(parts[34]),
    sourceName: "腾讯证券实时行情",
    sourceUrl: `https://gu.qq.com/${ts}`,
  };
}

async function sinaRealtime(code: string): Promise<RealtimeQuote> {
  const ts = tencentSymbol(code);
  const text = await fetchText(`https://hq.sinajs.cn/list=${ts}`, {
    Referer: "https://finance.sina.com.cn",
  });
  const m = text.match(/="([^"]*)"/);
  if (!m) throw new Error("新浪实时解析失败");
  const parts = m[1].split(",");
  const price = num(parts[3]);
  if (price === null) throw new Error("新浪实时价格缺失");
  const previousClose = num(parts[2]);
  const changePercent = previousClose ? ((price - previousClose) / previousClose) * 100 : null;
  return {
    code,
    name: parts[0] || null,
    price,
    previousClose,
    changePercent,
    open: num(parts[1]),
    high: num(parts[4]),
    low: num(parts[5]),
    sourceName: "新浪财经实时行情",
    sourceUrl: `https://finance.sina.com.cn/realstock/company/${ts}/nc.shtml`,
  };
}

/**
 * 腾讯证券「个股资料」接口（qt.gtimg.cn）附带市盈率/市净率。
 * 该接口在国内网络稳定可达（与实时行情同源），作为 push2.eastmoney.com
 * （部分网络环境被掐、TLS 建连后 HTTP 超时）取 PE/PB 的可靠主源。
 *
 * 字段（~ 分隔，索引从 0 起，公开稳定格式）：
 *   1  = 名称
 *   3  = 当前价
 *   39 = 市盈率(PE, 真实值，如 79.33)
 *   44/45 = 市净率(PB, 不同版本位置有小差异，真实值如 5.49)
 *
 * 兼容处理：PE 取 parts[39]；PB 在 parts[44]/parts[45] 两个候选位中，
 * 选「落在 (0,50] 且不大于 PE」的更合理值，以避免版本差异取错列。
 */
async function tencentProfile(code: string): Promise<Partial<StockProfile>> {
  const ts = tencentSymbol(code);
  // 该源仅为 PE/PB 的补充来源：请求失败时静默降级为 profileError，
  // 不能向上抛错，否则会让 getProfile 的 Promise.all 整体失败（东财等其它源的数据也一起丢失）。
  let text: string;
  try {
    text = await fetchText(`https://qt.gtimg.cn/q=${ts}`);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { profileError: `腾讯基本面接口请求失败：${reason} (${ts})` };
  }
  const m = text.match(/="([^"]*)"/);
  if (!m) return { profileError: `腾讯基本面解析失败 (${ts})` };
  const parts = m[1].split("~");
  const pe = num(parts[39]);
  // PB 候选位：取合理值（市净率通常 < 50，且不大于市盈率）
  const pbCandidates = [num(parts[44]), num(parts[45])].filter(
    (v): v is number => v !== null && v > 0 && v <= 50 && (pe === null || v <= pe),
  );
  const pb = pbCandidates.length ? pbCandidates[0] : num(parts[44]) ?? num(parts[45]);
  const name = parts[1] || null;
  if (pe === null && pb === null) return { profileError: `腾讯基本面字段缺失 (${ts})` };
  return {
    name: name || null,
    pe,
    pb,
  };
}

/** 实时行情，多级降级；全部失败返回 null（调用方应回退到历史K线推算值）。
 * 优先级：麦蕊（仅配置 MAIRUI_TOKEN 时）→ 腾讯 → 新浪 → 东方财富（兜底）。
 * 注：push2.eastmoney.com 在部分网络环境被掐，放在最后作兜底，避免拖慢首屏。 */
async function fetchRealtime(code: string): Promise<RealtimeQuote | null> {
  if (await isMairuiEnabled()) {
    try {
      const m = await getMairuiRealtime(code);
      if (m && m.price !== null) {
        return {
          code,
          name: m.name,
          price: m.price,
          previousClose: m.previousClose,
          changePercent: m.changePercent,
          open: null,
          high: null,
          low: null,
          sourceName: "麦蕊实时行情",
          sourceUrl: `https://www.mairuiapi.com`,
        };
      }
    } catch {
      // 麦蕊异常：降级到免费源
    }
  }
  for (const provider of [tencentRealtime, sinaRealtime, eastmoneyRealtime]) {
    try {
      return await provider(code);
    } catch {
      // 尝试下一个数据源
    }
  }
  return null;
}

export async function getRealtime(code: string): Promise<RealtimeQuote | null> {
  const key = code.trim();
  const now = Date.now();
  const cached = realtimeCache.get(key);
  if (cached && cached.expiresAt > now) return await cached.value;

  const promise = fetchRealtime(key);
  realtimeCache.set(key, { expiresAt: now + REALTIME_CACHE_MS, value: promise });
  try {
    const result = await promise;
    if (result) {
      realtimeCache.set(key, { expiresAt: Date.now() + REALTIME_CACHE_MS, value: result });
    } else {
      realtimeCache.delete(key);
    }
    return result;
  } catch (e) {
    // 拉取失败不要把 rejected promise 留在缓存里（否则窗口期内重复抛错且无法重试），
    // 直接移除缓存并向上抛出，由调用方降级处理。
    realtimeCache.delete(key);
    throw e;
  }
}

// ---------------------------------------------------------------------------
// 历史 K 线：东方财富 → 腾讯
// ---------------------------------------------------------------------------

async function eastmoneyKlines(code: string): Promise<KlineResult> {
  const secid = eastmoneySecid(code);
  const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&klt=101&fqt=1&beg=0&end=20500101&lmt=900&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56`;
  const data = await fetchJson<{ data?: { klines?: string[] } }>(url);
  const rows = (data.data?.klines ?? [])
    .map((line) => line.split(","))
    .filter((c) => c.length >= 6 && Number.isFinite(Number(c[2])))
    .map((c) => ({
      date: c[0],
      open: Number(c[1]),
      close: Number(c[2]),
      high: Number(c[3]),
      low: Number(c[4]),
      volume: Number(c[5] ?? 0),
    }));
  if (rows.length < 20) throw new Error("东方财富K线不足");
  return { rows, sourceName: "东方财富历史K线", sourceUrl: `https://quote.eastmoney.com/${secid}.html` };
}

async function tencentKlines(code: string): Promise<KlineResult> {
  const ts = tencentSymbol(code);
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${ts},day,,,800,qfq`;
  const data = await fetchJson<{ data?: Record<string, { qfqday?: string[][]; day?: string[][] }> }>(url);
  const rowsRaw = data.data?.[ts]?.qfqday ?? data.data?.[ts]?.day ?? [];
  const rows = rowsRaw
    .filter((r) => r.length >= 5 && Number.isFinite(Number(r[2])))
    .map((r) => ({
      date: r[0],
      open: Number(r[1]),
      close: Number(r[2]),
      high: Number(r[3]),
      low: Number(r[4]),
      volume: Number(r[5] ?? 0),
    }));
  if (rows.length < 20) throw new Error("腾讯K线不足");
  return { rows, sourceName: "腾讯证券历史K线", sourceUrl: `https://gu.qq.com/${ts}` };
}

/** 历史日K，多级降级；全部失败抛错。
 * 优先级：腾讯（稳定可达）→ 东方财富 push2his（兜底，部分网络被掐）。 */
export async function getKlines(code: string): Promise<KlineResult> {
  let lastError: unknown;
  for (const provider of [tencentKlines, eastmoneyKlines]) {
    try {
      return await provider(code);
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(lastError instanceof Error ? lastError.message : "公开行情暂时不可用，请稍后重试");
}

// ---------------------------------------------------------------------------
// 基本面：东方财富(名称/市值/PE/PB) + 麦蕊(可选,ROE/净利/行业/简介) + 东财f100(行业/简介兜底)
// ---------------------------------------------------------------------------

async function eastmoneyProfile(code: string): Promise<Partial<StockProfile>> {
  const secid = eastmoneySecid(code);
  const fields = "f43,f44,f45,f46,f57,f58,f60,f116,f162,f167";
  const url = `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=${fields}&invt=2&_=${Date.now()}`;
  try {
    const res = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(TIMEOUT) });
    if (!res.ok) {
      return { profileError: `东财基本面接口返回 HTTP ${res.status} (secid=${secid})` };
    }
    const data = await res.json() as { data?: Record<string, string | null> };
    const d = data.data;
    if (!d) {
      return { profileError: `东财基本面接口返回空 data (secid=${secid})` };
    }
    const peRaw = num(d.f162);
    const pbRaw = num(d.f167);
    return {
      name: typeof d.f58 === "string" && d.f58 ? d.f58 : null,
      marketCap: num(d.f116),
      // 东财 push2 的市盈率/市净率字段（f162/f167）为「真实值 ×100」的整数原始值，需 /100 还原。
      pe: peRaw !== null ? peRaw / 100 : null,
      pb: pbRaw !== null ? pbRaw / 100 : null,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { profileError: `东财基本面接口请求失败：${reason} (secid=${secid})` };
  }
}

/** 东方财富「基本资料」(f100) 兜底：在国内环境稳定可用，提供行业与主营业务简介，
 * 作为麦蕊未配置时的行业/简介兜底。 */
async function eastmoneyF100Profile(code: string): Promise<Partial<StockProfile>> {
  const secid = eastmoneySecid(code);
  const url = `https://emweb.securities.eastmoney.com/PC_HSF10/BusinessAnalysis/PageAjax?code=${secid}`;
  try {
    const res = await fetch(url, { headers: { "user-agent": UA, Referer: "https://emweb.securities.eastmoney.com/" }, signal: AbortSignal.timeout(TIMEOUT) });
    if (!res.ok) return {};
    const data = await res.json() as {
      MainBusiness?: Array<{ MAINOP_TYPE_NAME?: string; MAINOP_BUSINESS?: string }>;
    };
    const main = data.MainBusiness ?? [];
    const industry = main.find((item) => item.MAINOP_TYPE_NAME === "行业")?.MAINOP_BUSINESS?.trim() || null;
    const businessSummary = main
      .map((item) => `${item.MAINOP_TYPE_NAME ?? ""}:${item.MAINOP_BUSINESS ?? ""}`)
      .slice(0, 4)
      .join("；") || null;
    return { industry, businessSummary };
  } catch {
    return {};
  }
}

// 东方财富「财务主指标」(datacenter) 兜底：在国内环境稳定可达，免费，用于补充
// grossMargin(毛利率) / profitMargin(净利率) / roe(净资产收益率) / operatingCashflow(经营现金流) / sector(行业)。
// 注：GROSS_PROFIT_RATIO / NETPROFIT_RATIO / ROE 均为百分比数值（如 91.5），已除 100 归一为小数；
//     若实际部署环境该接口返回的是小数，需去掉 /100。失败时静默退化为 null。
type EmFundamentals = {
  grossMargin: number | null;
  profitMargin: number | null;
  roe: number | null;
  operatingCashflow: number | null;
  sector: string | null;
};
async function eastmoneyFundamentals(code: string): Promise<EmFundamentals> {
  const secu = code.replace(/\.(SS|SZ|SH|BJ)$/i, "");
  const url = `https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=RPT_F10_FIN_MAININDICATOR&columns=SECUCODE,SECURITY_CODE,REPORT_DATE,GROSS_PROFIT_RATIO,NETPROFIT_RATIO,ROE,OPERATE_CASH_FLOW,INDUSTRY_NAME&filter=(SECURITY_CODE%3D%22${secu}%22)&pageSize=5&sortColumns=REPORT_DATE&sortTypes=-1&source=HSF10&client=PC`;
  const empty: EmFundamentals = { grossMargin: null, profitMargin: null, roe: null, operatingCashflow: null, sector: null };
  try {
    const res = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(TIMEOUT) });
    if (!res.ok) return empty;
    const data = await res.json() as {
      data?: { result?: { data?: Array<Record<string, unknown>> } };
    };
    const rows = data.data?.result?.data ?? [];
    const row = rows[0];
    if (!row) return empty;
    const pct = (v: unknown) => { const n = Number(v); return Number.isFinite(n) && n !== 0 ? n / 100 : null; };
    const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
    const industry = row.INDUSTRY_NAME;
    return {
      grossMargin: pct(row.GROSS_PROFIT_RATIO),
      profitMargin: pct(row.NETPROFIT_RATIO),
      roe: pct(row.ROE ?? row.WEIGHTAVG_ROE),
      operatingCashflow: num(row.OPERATE_CASH_FLOW),
      sector: typeof industry === "string" ? industry : null,
    };
  } catch {
    return empty;
  }
}

/** 基本面资料。
 * 东方财富对 A 股的名称/总市值/PE/PB 更可靠优先；
 * roe/profitMargin/businessSummary/industry 优先用麦蕊（仅配置 token 时），否则由东方财富财务主指标兜底；
 * grossMargin/operatingCashflow/sector 由东方财富「财务主指标」免费接口补充（国内稳定可达）。 */
export async function getProfile(code: string): Promise<StockProfile> {
  const mairuiEnabled = await isMairuiEnabled();
  const [em, tencent, mairui, emF100, emFund] = await Promise.all([
    eastmoneyProfile(code),
    tencentProfile(code),
    // 麦蕊为可选增强源，异常时静默降级为 null，交由下方东财兜底。
    mairuiEnabled ? getMairuiFundamentals(code).catch(() => null) : Promise.resolve(null),
    eastmoneyF100Profile(code),
    eastmoneyFundamentals(code),
  ]);
  // PE/PB 优先用腾讯（国内网络稳定可达）；push2 东财在部分网络环境被掐时静默降级。
  const pe = tencent.pe ?? em.pe ?? null;
  const pb = tencent.pb ?? em.pb ?? null;
  const profileError =
    pe == null || pb == null
      ? tencent.profileError ?? em.profileError ?? null
      : null;
  return {
    name: tencent.name ?? em.name ?? null,
    marketCap: em.marketCap ?? null,
    pe,
    pb,
    // 麦蕊(配置 token 时)优先，否则东方财富财务主指标兜底（无 token 也能填）。
    roe: mairui?.roe ?? emFund.roe ?? null,
    // 东方财富财务主指标免费接口兜底（无 token 也可用）。
    grossMargin: emFund.grossMargin,
    profitMargin: mairui?.profitMargin ?? emFund.profitMargin ?? null,
    operatingCashflow: emFund.operatingCashflow,
    sector: emFund.sector,
    // 行业/简介：麦蕊优先 → 东方财富 f100 兜底（国内稳定）
    industry: mairui?.industry ?? emF100.industry ?? null,
    businessSummary: mairui?.businessSummary ?? emF100.businessSummary ?? null,
    profileError,
  };
}

// ---------------------------------------------------------------------------
// AKShare(_em 分支) 等效端点：概念板块、个股资金流
// ---------------------------------------------------------------------------

/** 概念板块列表（等效于 AKShare stock_board_concept_name_em，底层即东方财富公开接口）。 */
export async function conceptBoards(): Promise<ConceptBoard[]> {
  const url = `https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=500&fs=m:90+t:3&fields=f12,f14`;
  const data = await fetchJson<{ data?: { diff?: Array<{ f12?: string; f14?: string }> } }>(url);
  const diff = data.data?.diff ?? [];
  return diff
    .filter((d) => d.f12 && d.f14)
    .map((d) => ({ code: d.f12 as string, name: d.f14 as string }));
}

/** 个股主力资金净流入（等效于 AKShare stock_individual_fund_flow，底层即东方财富公开接口）。 */
export async function fundFlow(code: string): Promise<FundFlow> {
  const secid = eastmoneySecid(code);
  const url = `https://push2.eastmoney.com/api/qt/stock/fflow/daykline/get?lmt=1&klt=101&secid=${secid}&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64,f65`;
  const data = await fetchJson<{ data?: { klines?: string[] } }>(url);
  const last = data.data?.klines?.at(-1);
  if (!last) throw new Error("资金流数据缺失");
  const cells = last.split(",");
  // f52 = 主力净流入额（元）
  return { code, mainNetInflow: num(cells[1] ?? ""), sourceName: "东方财富资金流(akshare_em)" };
}

// ---------------------------------------------------------------------------
// 大盘指数（东方财富批量接口，见 lib/indices.ts）
// ---------------------------------------------------------------------------

export { getIndexQuotes } from "./indices";

// ---------------------------------------------------------------------------
// 通达信（pytdx）状态说明：当前 Workers 运行时不可用
// ---------------------------------------------------------------------------

export const TDX_SUPPORTED = false;

export function tdxNote(): string {
  return [
    "通达信(pytdx)直连行情服务器走二进制 TCP 私有协议，Cloudflare Workers 运行时",
    "无法对任意主机发起原生 TCP 连接，故当前不可用于直连。",
    "若部署在 Docker/Node 并起一个 Python 侧车代理，可把 TDX 作为更高优先级层接入",
    "（实时行情与财务数据的后备）；当前由腾讯/新浪承担其后备角色。",
  ].join("");
}
