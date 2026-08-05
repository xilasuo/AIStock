// 麦蕊智数（mairuiapi.com）实时行情增强层。
//
// 设计定位：作为「可选增强层」。只在配置了 MAIRUI_TOKEN 时，
// 用其原生 A 股实时行情覆盖由免费源推算出的现价/涨跌；
// 若未配置 token / 网络错误 / 字段缺失 / 额度耗尽，全部静默降级回免费多源，
// 不抛异常，保证整体流程不受影响。
//
// 注意：麦蕊返回字段命名未完全公开，下方对常见中英文键名做容错提取；
// 确切字段（实时行情路径 /hsstock/real/time/{code}/{licence}）建议拿到 token 后
// 在其 Playground 核对一次，再调整下方 pick() 的候选键。

const MAIRUI_BASE = "https://api.mairuiapi.com";
const REALTIME_TTL_MS = 5 * 60 * 1000; // 同只股票 5 分钟内不重复请求，缓解重复刷新浪费额度
export type MairuiRealtime = {
  price: number | null;
  previousClose: number | null;
  changePercent: number | null;
  pe: number | null;
  pb: number | null;
  name: string | null;
};

// 模块级缓存：减少单次进程内重复刷新对同一额度的浪费。
// 注意：Worker 多 isolate 不共享此缓存，跨请求持久缓存需用 KV/D1。
const cache = new Map<string, { ts: number; data: MairuiRealtime }>();
// 额度/鉴权失败（401/403）后进入冷却：指数退避（5 分钟起，翻倍封顶 2 小时），
// 既避免持续打 401 浪费请求，又能在临时故障/额度恢复后较快自动恢复。
let disabledUntil = 0;
let circuitBackoffMs = 5 * 60 * 1000;
const CIRCUIT_MAX_BACKOFF_MS = 2 * 60 * 60 * 1000;

function tripCircuit() {
  disabledUntil = Date.now() + circuitBackoffMs;
  circuitBackoffMs = Math.min(circuitBackoffMs * 2, CIRCUIT_MAX_BACKOFF_MS);
}

function resetCircuit() {
  disabledUntil = 0;
  circuitBackoffMs = 5 * 60 * 1000;
}

/** 熔断状态（供 /api/status 展示，让"麦蕊停用"对用户可见而非静默降级）。 */
export function mairuiCircuit(): { tripped: boolean; retryAfterMs: number } {
  const remain = disabledUntil - Date.now();
  return remain > 0 ? { tripped: true, retryAfterMs: remain } : { tripped: false, retryAfterMs: 0 };
}

async function getMairuiToken(): Promise<string> {
  // Worker 运行时通过 cloudflare:workers 的 env 读取（与 ai-config.ts 一致）。
  try {
    const spec = "cloudflare:workers";
    const mod = await import(/* @vite-ignore */ spec);
    const token = (mod as { env?: Record<string, string | undefined> }).env?.MAIRUI_TOKEN;
    if (token) return token;
  } catch {
    // 非 Worker 运行时（node 测试 / 本地）回退到 process.env
  }
  return typeof process !== "undefined" ? process.env?.MAIRUI_TOKEN ?? "" : "";
}

/** 是否已配置麦蕊 token（未配置时整个增强层不启用，自动走免费多源）。 */
export async function isMairuiEnabled(): Promise<boolean> {
  return (await getMairuiToken()).length > 0 && Date.now() >= disabledUntil;
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// 麦蕊返回字段命名未完全公开，这里对常见中英文键名做容错提取（大小写不敏感）。
function pick(row: Record<string, unknown>, keys: string[]): number | null {
  const lower = new Map(Object.entries(row).map(([k, v]) => [k.toLowerCase(), v]));
  for (const key of keys) {
    const value = row[key] ?? lower.get(key.toLowerCase());
    const n = num(value);
    if (n !== null) return n;
  }
  return null;
}

// 麦蕊实时行情真实字段（已用真实响应核对）：
//   pc = 现价（元，真实价，非百分之一/分单位）、up = 涨停价、dp = 跌停价、
//   pk = 最小变动价位、fv/tv = 流通/总股本、name = 名称。
//   响应里【没有】 pe/pb，也没有独立的涨跌幅字段；涨跌幅由现价-昨收推算。
//   旧候选键 p/price/zxj/pc-as-涨跌幅 是误读，会导致价格解析永远 null、
//   且把现价(1320)当成 +1320% 涨跌幅，已废弃。
function parseRealtime(row: Record<string, unknown>): MairuiRealtime {
  const rawPrice = num(row.pc) ?? pick(row, ["last", "now", "current", "trade"]);
  const previousClose = pick(row, ["yc", "preClose", "prevClose", "zcj", "yclose", "previousClose"]);

  // 数据合理性校验：价格必须为正；若异常则整笔丢弃，由调用方回退到历史K线。
  const price = rawPrice !== null && rawPrice > 0 ? rawPrice : null;

  // 麦蕊实时响应无涨跌幅字段，由现价-昨收推算。
  let changePercent: number | null = null;
  if (price !== null && previousClose && previousClose > 0) {
    changePercent = ((price - previousClose) / previousClose) * 100;
  }

  // 涨跌幅二次校验：A股普通股票±10%、科创板/创业板±20%，
  // 超出 ±30% 视为异常数据，丢弃以免出现 -142% 等荒谬值。
  const MAX_CHANGE_PERCENT = 30;
  if (changePercent !== null && Math.abs(changePercent) > MAX_CHANGE_PERCENT) {
    return { price: null, previousClose: null, changePercent: null, pe: null, pb: null, name: null };
  }

  const name =
    typeof row.name === "string" && row.name ? row.name
      : typeof row.mc === "string" ? row.mc
        : null;
  // 麦蕊实时接口实测返回 pe 与 pb_ratio（市净率），直接解析；
  // 让 PE/PB 也能从麦蕊（第一优先级）取到，缺失时回退给腾讯/东财。
  const pe = pick(row, ["pe", "pe_ttm", "市盈率"]);
  const pb = pick(row, ["pb_ratio", "pb", "市净率"]);
  return { price, previousClose, changePercent, pe, pb, name };
}

export async function getMairuiRealtime(code: string, force = false): Promise<MairuiRealtime | null> {
  const token = await getMairuiToken();
  if (!token) return null;
  if (Date.now() < disabledUntil) return null;

  const cached = cache.get(code);
  // force=true（"重新分析"）时跳过 TTL 缓存，强制拉最新；熔断期仍不发起请求
  if (cached && !force && Date.now() - cached.ts < REALTIME_TTL_MS) return cached.data;

  // 实时行情路径（licence 拼在末尾）。如与官方文档不符，改这一行即可。
  const url = `${MAIRUI_BASE}/hsstock/real/time/${code}/${token}`;
  try {
    const res = await fetch(url, {
      headers: { "user-agent": "Mozilla/5.0 StockReviewAssistant/1.0" },
      signal: AbortSignal.timeout(6_000),
    });
    // 免费档超额/鉴权失败：进入指数退避冷却，避免持续触发限流
    if (res.status === 401 || res.status === 403) {
      tripCircuit();
      return null;
    }
    if (!res.ok) return null;
    const row = await res.json() as Record<string, unknown>;
    const data = parseRealtime(row);
    if (data.price === null) return null;
    resetCircuit();
    cache.set(code, { ts: Date.now(), data });
    return data;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 财务与资料增强层（cwzb 财务指标 / gsjj 公司简介 / zg 概念树提取行业）。
// 补充 MarketDataProvider 免费链路不覆盖的 roe / profitMargin / businessSummary /
// industry 字段；麦蕊作为原生 A 股数据源，比已移除的 Yahoo 兜底更稳定。
//
// 字段真相（已用真实接口核对）：
//   cwzb.jzsy = 净资产收益率(%)、cwzb.xsjl = 销售净利率(%) —— 均为百分比数值，
//   需 ÷100 转成与 Yahoo financialData(0.x 小数) 一致的格式。
//   gsjj.desc = 公司中文简介。
//   /hszg/zg/{code}/{licence} 返回 [{code,name}]，含「申万行业」「概念」等标签。
// ---------------------------------------------------------------------------

const FUND_TTL_MS = 30 * 60 * 1000; // 财务/资料变化慢，30 分钟缓存
const fundCache = new Map<string, { ts: number; data: MairuiFundamentals }>();

export type MairuiFundamentals = {
  roe: number | null; // 净资产收益率（小数，与 Yahoo 对齐）
  profitMargin: number | null; // 销售净利率（小数）
  businessSummary: string | null; // 中文公司简介
  industry: string | null; // 行业标签（从申万行业概念提取）
  /**
   * 营收同比（%）——由 cwzb 相邻两期主营收入(zyyw)推算；
   * 仅在相邻期口径一致（同为季末/年末）时给出，否则为 null 交 Yahoo 兜底。
   */
  revenueGrowth: number | null;
  /** 利润同比（%）——由 cwzb 相邻两期扣非净利润(kflr)推算；口径不一致时为 null。 */
  profitGrowth: number | null;
  /**
   * 资产负债率（小数，0~1）——直接取麦蕊 cwzb 的 zcfzl(%) 转小数；
   * 该字段麦蕊原生直接给出，比用总负债/总资产推算更可靠。
   */
  debtRatio: number | null;
};

// 麦蕊财务比率返回百分比数值，转小数以对齐 Yahoo（Yahoo financialData 为 0.x）
function pct(value: unknown): number | null {
  const n = num(value);
  if (n === null) return null;
  return n / 100;
}

// 麦蕊字段命名未完全公开，对每个财务指标给出常见候选键名（中英拼音）做容错提取。
// 全部未命中则返回 null，由调用方回退到免费源，不影响主流程。
function pickKey(row: Record<string, unknown>, candidates: string[]): number | null {
  return pick(row, candidates);
}

// 从 cwzb 多期数组中提取基础财务项。cwzb 按时间倒序，[0] 为最新一期，[1] 为上一期。
// 真实字段已用麦蕊接口实测核对（贵州茅台 600519）：
//   zyyw = 主营业务收入(元)、kflr = 扣非净利润(元)、zzc = 总资产(元)、zcfzl = 资产负债率(%)。
// 注意：麦蕊 cwzb 各期可能是单季或累计口径（如 Q1 单季 ROE=10%、年报累计 ROE=33%），
// 直接对相邻两期 zyyw/kflr 算"同比"会在单季/累计口径切换时严重失真，
// 因此营收/利润增长率仅在相邻期口径一致（date 同为季末或同为年末）时才推算，否则为 null。
type FinRow = {
  revenue: number | null; // 单期主营收入（元）
  netProfit: number | null; // 单期扣非净利润（元）
  totalAssets: number | null; // 期末总资产（元）
  debtRatioPct: number | null; // 资产负债率（%，直接给出）
  date: string | null; // 报告期（YYYY-MM-DD），用于口径一致性判断
  isYearEnd: boolean; // 是否为年报（12-31）
};
function parseFinRows(rows: unknown): FinRow[] {
  if (!Array.isArray(rows)) return [];
  return rows.map((item) => {
    const row = (item ?? {}) as Record<string, unknown>;
    const date = typeof row.date === "string" ? row.date : null;
    return {
      revenue: pickKey(row, ["zyyw", "yy", "totalrevenue", "revenue", "income", "营业额", "营业收入"]),
      netProfit: pickKey(row, ["kflr", "jlr", "netprofit", "netincome", "净利润", "归母净利润"]),
      totalAssets: pickKey(row, ["zzc", "zcz", "totalassets", "总资产"]),
      debtRatioPct: pickKey(row, ["zcfzl", "debtratio", "资产负债率", "zfzl"]),
      date,
      isYearEnd: date != null && date.endsWith("-12-31"),
    };
  });
}

function parseFinancials(rows: unknown): {
  roe: number | null;
  profitMargin: number | null;
  revenueGrowth: number | null;
  profitGrowth: number | null;
  debtRatio: number | null;
} {
  const out = { roe: null, profitMargin: null, revenueGrowth: null, profitGrowth: null, debtRatio: null } as {
    roe: number | null;
    profitMargin: number | null;
    revenueGrowth: number | null;
    profitGrowth: number | null;
    debtRatio: number | null;
  };
  if (!Array.isArray(rows) || rows.length === 0) return out;
  // cwzb 按时间倒序，[0] 为最新一期
  const latest = (rows[0] ?? {}) as Record<string, unknown>;
  out.roe = pct(pickKey(latest, ["jzsy", "roe", "净资产收益率"]));
  out.profitMargin = pct(pickKey(latest, ["xsjl", "profitmargin", "netmargin", "销售净利率"]));

  // 资产负债率：麦蕊直接给出百分比（如 12.12 表示 12.12%），÷100 转小数对齐 debtRatio 语义
  const debtPct = pickKey(latest, ["zcfzl", "debtratio", "资产负债率", "zfzl"]);
  if (debtPct !== null) out.debtRatio = debtPct / 100;

  // 营收/利润同比：仅在相邻两期口径一致（同为季末或同为年末）时推算，避免单季/累计失真
  const finRows = parseFinRows(rows);
  if (finRows.length >= 2) {
    const cur = finRows[0];
    const prev = finRows[1];
    const sameScope = cur.isYearEnd === prev.isYearEnd && cur.date !== prev.date;
    if (sameScope) {
      if (cur.revenue != null && prev.revenue != null && prev.revenue !== 0) {
        out.revenueGrowth = ((cur.revenue - prev.revenue) / Math.abs(prev.revenue)) * 100;
      }
      if (cur.netProfit != null && prev.netProfit != null && prev.netProfit !== 0) {
        out.profitGrowth = ((cur.netProfit - prev.netProfit) / Math.abs(prev.netProfit)) * 100;
      }
    }
    // 口径不一致时：不强行给同比，交给 Yahoo 兜底，避免给出错误增长数据
  }
  return out;
}

function parseCompanyProfile(obj: unknown): string | null {
  if (!obj || typeof obj !== "object") return null;
  const desc = (obj as Record<string, unknown>).desc;
  if (typeof desc === "string") {
    const trimmed = desc.trim();
    // 简介过长会显著抬高 AI prompt token，截断到合理长度
    return trimmed.length > 0 ? trimmed.slice(0, 4000) : null;
  }
  return null;
}

function parseIndustry(rows: unknown): string | null {
  if (!Array.isArray(rows)) return null;
  // 优先取申万行业标签
  for (const r of rows) {
    const name = (r as Record<string, unknown>).name;
    if (typeof name === "string" && name.includes("申万行业")) {
      const parts = name.split("申万行业-");
      return parts[1] ?? name;
    }
  }
  // 退而求其次：任何含「行业」的标签取其末段
  for (const r of rows) {
    const name = (r as Record<string, unknown>).name;
    if (typeof name === "string" && name.includes("行业")) {
      const parts = name.split(/[-—]/);
      return parts[parts.length - 1];
    }
  }
  return null;
}

export async function getMairuiFundamentals(code: string, force = false): Promise<MairuiFundamentals | null> {
  const token = await getMairuiToken();
  if (!token) return null;
  if (Date.now() < disabledUntil) return null;

  const cacheKey = `fund:${code}`;
  const cached = fundCache.get(cacheKey);
  // force=true（"重新分析"）时跳过财务 TTL 缓存
  if (cached && !force && Date.now() - cached.ts < FUND_TTL_MS) return cached.data;

  const headers = { "user-agent": "Mozilla/5.0 StockReviewAssistant/1.0" };
  try {
    // 三个接口并行；code 用 6 位纯数字（已用真实接口核对，.SH 后缀反而 404）
    const [cwzbRes, gsjjRes, conceptsRes] = await Promise.all([
      fetch(`${MAIRUI_BASE}/hscp/cwzb/${code}/${token}`, { headers, signal: AbortSignal.timeout(10_000) }),
      fetch(`${MAIRUI_BASE}/hscp/gsjj/${code}/${token}`, { headers, signal: AbortSignal.timeout(10_000) }),
      fetch(`${MAIRUI_BASE}/hszg/zg/${code}/${token}`, { headers, signal: AbortSignal.timeout(10_000) }),
    ]);
    for (const res of [cwzbRes, gsjjRes, conceptsRes]) {
      if (res.status === 401 || res.status === 403) {
        tripCircuit();
        return null;
      }
    }
    const [cwzb, gsjj, concepts] = await Promise.all([
      cwzbRes.ok ? cwzbRes.json() : Promise.resolve(null),
      gsjjRes.ok ? gsjjRes.json() : Promise.resolve(null),
      conceptsRes.ok ? conceptsRes.json() : Promise.resolve(null),
    ]);

    const fin = parseFinancials(cwzb);
    const result: MairuiFundamentals = {
      roe: fin.roe,
      profitMargin: fin.profitMargin,
      businessSummary: parseCompanyProfile(gsjj),
      industry: parseIndustry(concepts),
      revenueGrowth: fin.revenueGrowth,
      profitGrowth: fin.profitGrowth,
      debtRatio: fin.debtRatio,
    };
    // 仅在有实际数据时缓存，避免缓存全 null 导致后续永远跳过
    if (
      result.roe !== null ||
      result.profitMargin !== null ||
      result.businessSummary ||
      result.industry ||
      result.revenueGrowth !== null ||
      result.profitGrowth !== null ||
      result.debtRatio !== null
    ) {
      resetCircuit();
      fundCache.set(cacheKey, { ts: Date.now(), data: result });
    }
    return result;
  } catch {
    return null;
  }
}
