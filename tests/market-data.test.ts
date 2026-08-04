import assert from "node:assert/strict";
import test from "node:test";
import { mock } from "node:test";
import { getKlines, getProfile } from "../lib/market/market-data";

// 根据 URL 返回不同响应的 fetch mock，用于隔离外部行情源。
function makeRouter(routes: Record<string, (url: string) => unknown>) {
  return mock.fn(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    for (const key of Object.keys(routes)) {
      if (url.includes(key)) {
        const body = routes[key](url);
        if (body instanceof Error) throw body;
        return { ok: true, status: 200, json: async () => body } as Response;
      }
    }
    return { ok: false, status: 404, json: async () => ({}) } as Response;
  });
}

function emKlinesBody(n = 25) {
  return { data: { klines: Array.from({ length: n }, (_, i) => `2024-01-${String(i + 1).padStart(2, "0")},10,11,12,9,1000`) } };
}

test.beforeEach(() => {
  mock.restoreAll();
});

test("getKlines 优先东方财富（Yahoo 已移除，链仅东财+腾讯两级）", async () => {
  const fetchMock = makeRouter({
    "push2his.eastmoney.com": () => emKlinesBody(),
    "web.ifzq.gtimg.cn": () => new Error("腾讯挂了"),
  });
  mock.method(globalThis, "fetch", fetchMock as unknown as typeof fetch);

  const result = await getKlines("600519");
  assert.equal(result.sourceName, "东方财富历史K线");
  assert.ok(result.rows.length >= 20);
});

test("getKlines 东财+腾讯都失败直接抛错（无 Yahoo 第三级兜底）", async () => {
  const fetchMock = makeRouter({
    "push2his.eastmoney.com": () => new Error("东财挂了"),
    "web.ifzq.gtimg.cn": () => new Error("腾讯挂了"),
  });
  mock.method(globalThis, "fetch", fetchMock as unknown as typeof fetch);

  await assert.rejects(() => getKlines("600519"));
});

test("getProfile 东财填充名称/PE/PB，无麦蕊 token 时 roe/profitMargin 仍由财务主指标兜底", async () => {
  const fetchMock = makeRouter({
    "push2.eastmoney.com": () => ({ data: { f58: "测试股份", f116: "1234567890", f162: "1850", f167: "210" } }),
    "emweb.securities.eastmoney.com": () => ({ MainBusiness: [{ MAINOP_TYPE_NAME: "行业", MAINOP_BUSINESS: "半导体" }] }),
    "datacenter.eastmoney.com": () => ({
      data: { result: { data: [{ SECURITY_CODE: "600519", GROSS_PROFIT_RATIO: 91.5, NETPROFIT_RATIO: 50.2, ROE: 25.3, OPERATE_CASH_FLOW: 123456789, INDUSTRY_NAME: "白酒" }] } },
    }),
    "api.mairuiapi.com": () => new Error("不应命中麦蕊（未配置 token）"),
  });
  mock.method(globalThis, "fetch", fetchMock as unknown as typeof fetch);

  const profile = await getProfile("600519");
  assert.equal(profile.name, "测试股份");
  assert.equal(profile.pe, 18.5); // 1850 / 100
  assert.equal(profile.pb, 2.1); // 210 / 100
  assert.equal(profile.industry, "半导体");
  // 财务主指标兜底（无 token 也能填）
  assert.equal(profile.roe, 0.253, "ROE 25.3% 应归一为 0.253");
  assert.equal(profile.profitMargin, 0.502, "净利率 50.2% 应归一为 0.502");
  assert.equal(profile.grossMargin, 0.915, "毛利率 91.5% 应归一为 0.915");
  assert.equal(profile.operatingCashflow, 123456789);
  assert.equal(profile.sector, "白酒");
});

test("getProfile 配置麦蕊 token 时 roe/profitMargin 优先用麦蕊", async () => {
  process.env.MAIRUI_TOKEN = "test-token";
  const fetchMock = makeRouter({
    "push2.eastmoney.com": () => ({ data: { f58: "测试股份", f116: "1234567890", f162: "1850", f167: "210" } }),
    "emweb.securities.eastmoney.com": () => ({ MainBusiness: [] }),
    "datacenter.eastmoney.com": () => ({
      data: { result: { data: [{ SECURITY_CODE: "600519", GROSS_PROFIT_RATIO: 91.5, NETPROFIT_RATIO: 50.2, ROE: 25.3, OPERATE_CASH_FLOW: 123456789, INDUSTRY_NAME: "白酒" }] } },
    }),
    "api.mairuiapi.com": (url) => {
      if (url.includes("/hscp/cwzb/")) return [{ jzsy: 30, xsjl: 55 }]; // roe=0.30, 净利率=0.55
      if (url.includes("/hscp/gsjj/")) return { desc: "麦蕊简介" };
      if (url.includes("/hszg/zg/")) return [{ name: "申万行业-白酒制造" }];
      return {};
    },
  });
  mock.method(globalThis, "fetch", fetchMock as unknown as typeof fetch);

  const profile = await getProfile("600519");
  // 麦蕊优先覆盖 roe/profitMargin
  assert.equal(profile.roe, 0.30, "应优先使用麦蕊 roe");
  assert.equal(profile.profitMargin, 0.55, "应优先使用麦蕊 profitMargin");
  // 其余仍由东财主指标兜底
  assert.equal(profile.grossMargin, 0.915);
  assert.equal(profile.sector, "白酒");
  delete process.env.MAIRUI_TOKEN;
});

test("getProfile 财务主指标接口失败时三个字段退化为 null（不影响主流程）", async () => {
  const fetchMock = makeRouter({
    "push2.eastmoney.com": () => ({ data: { f58: "测试股份", f116: "1234567890", f162: "1850", f167: "210" } }),
    "emweb.securities.eastmoney.com": () => ({ MainBusiness: [{ MAINOP_TYPE_NAME: "行业", MAINOP_BUSINESS: "半导体" }] }),
    "datacenter.eastmoney.com": () => new Error("东方财富财务主指标接口挂了"),
    "api.mairuiapi.com": () => new Error("不应命中麦蕊（未配置 token）"),
  });
  mock.method(globalThis, "fetch", fetchMock as unknown as typeof fetch);

  const profile = await getProfile("600519");
  assert.equal(profile.name, "测试股份");
  assert.equal(profile.grossMargin, null);
  assert.equal(profile.operatingCashflow, null);
  assert.equal(profile.sector, null);
});

test("getProfile 麦蕊 cwzb 多期数据可推算营收/利润增长与资产负债率", async () => {
  process.env.MAIRUI_TOKEN = "test-token";
  const fetchMock = makeRouter({
    "push2.eastmoney.com": () => ({ data: { f58: "测试股份", f116: "1234567890", f162: "1850", f167: "210" } }),
    "emweb.securities.eastmoney.com": () => ({ MainBusiness: [] }),
    "datacenter.eastmoney.com": () => ({
      data: { result: { data: [{ SECURITY_CODE: "000001", GROSS_PROFIT_RATIO: 91.5, NETPROFIT_RATIO: 50.2, ROE: 25.3, OPERATE_CASH_FLOW: 123456789, INDUSTRY_NAME: "白酒" }] } },
    }),
    "api.mairuiapi.com": (url) => {
      // 用麦蕊 cwzb 真实字段名（已实测核对）：zyyw 主营收入、kflr 扣非净利润、
      // zcfzl 资产负债率(%)、jzsy ROE(%)、xsjl 净利率(%)。相邻两期同为年报(12-31)口径一致。
      if (url.includes("/hscp/cwzb/")) return [
        { date: "2025-12-31", jzsy: 30, xsjl: 55, zyyw: 1200, kflr: 300, zzc: 10000, zcfzl: 40 },
        { date: "2024-12-31", jzsy: 28, xsjl: 50, zyyw: 1000, kflr: 250, zzc: 9000, zcfzl: 35 },
      ];
      if (url.includes("/hscp/gsjj/")) return { desc: "麦蕊简介" };
      if (url.includes("/hszg/zg/")) return [{ name: "申万行业-白酒制造" }];
      return {};
    },
  });
  mock.method(globalThis, "fetch", fetchMock as unknown as typeof fetch);

  // 注意：用 000001 避免与前面 600519 用例共享麦蕊 fundCache（cwzb 字段不同会互相污染）
  const profile = await getProfile("000001");
  assert.equal(profile.roe, 0.30, "麦蕊 ROE 优先");
  assert.equal(profile.profitMargin, 0.55, "麦蕊净利率优先");
  // 营收同比 = (1200-1000)/1000 = 20%（口径一致同为年报）
  assert.equal(profile.revenueGrowth, 20, "营收同比 20%");
  // 利润同比 = (300-250)/250 = 20%
  assert.equal(profile.profitGrowth, 20, "利润同比 20%");
  // 资产负债率 = 40% ÷ 100 = 0.4（麦蕊 zcfzl 直接给出，无需总负债/总资产推算）
  assert.equal(profile.debtRatio, 0.4, "资产负债率 0.4");
  delete process.env.MAIRUI_TOKEN;
});

test("getProfile 麦蕊 cwzb 相邻期口径不一致时不推算同比，避免单季/累计失真", async () => {
  process.env.MAIRUI_TOKEN = "test-token";
  const fetchMock = makeRouter({
    "push2.eastmoney.com": () => ({ data: { f58: "测试股份", f116: "1234567890", f162: "1850", f167: "210" } }),
    "emweb.securities.eastmoney.com": () => ({ MainBusiness: [] }),
    "datacenter.eastmoney.com": () => ({ data: { result: { data: [] } } }),
    "api.mairuiapi.com": (url) => {
      // 最新期是 2026-03-31（Q1 单季），上一期是 2025-12-31（全年累计）：口径不一致
      if (url.includes("/hscp/cwzb/")) return [
        { date: "2026-03-31", jzsy: 10.06, xsjl: 52.2, zyyw: 40161115859, kflr: 27239985194, zzc: 319918844905, zcfzl: 12.12 },
        { date: "2025-12-31", jzsy: 33.65, xsjl: 50.5, zyyw: 126591597259, kflr: 82293107655, zzc: 303834844021, zcfzl: 16.41 },
      ];
      if (url.includes("/hscp/gsjj/")) return { desc: "麦蕊简介" };
      if (url.includes("/hszg/zg/")) return [{ name: "申万行业-白酒制造" }];
      return {};
    },
  });
  mock.method(globalThis, "fetch", fetchMock as unknown as typeof fetch);

  const profile = await getProfile("000002");
  // 负债率仍可靠（麦蕊直接给出 12.12% → 0.1212；浮点计算存在微小误差，用容差比较）
  assert.ok(profile.debtRatio != null && Math.abs(profile.debtRatio - 0.1212) < 1e-9, "负债率直接取 zcfzl");
  // 营收/利润同比因口径不一致（单季 vs 累计）而为 null，避免给出错误的 -68% 之类
  assert.equal(profile.revenueGrowth, null, "口径不一致营收同比为 null");
  assert.equal(profile.profitGrowth, null, "口径不一致利润同比为 null");
  delete process.env.MAIRUI_TOKEN;
});

test("getProfile 麦蕊实时接口返回 pe/pb_ratio 时，PE/PB 麦蕊优先于腾讯/东财", async () => {
  process.env.MAIRUI_TOKEN = "test-token";
  const fetchMock = makeRouter({
    "push2.eastmoney.com": () => ({ data: { f58: "测试股份", f116: "1234567890", f162: "1850", f167: "210" } }),
    // 腾讯返回异常，确保 tencent.pe/pb 为 null，以验证麦蕊 pe/pb 真正生效
    "qt.gtimg.cn": () => new Error("腾讯挂了"),
    "datacenter.eastmoney.com": () => ({ data: { result: { data: [] } } }),
    "emweb.securities.eastmoney.com": () => ({ MainBusiness: [] }),
    "api.mairuiapi.com": (url) => {
      // 麦蕊实时行情：实测返回 pe 与 pb_ratio
      if (url.includes("/hsstock/real/time/")) return { pc: 1358.98, yc: 1350.6, pe: 15.59, pb_ratio: 7.2 };
      if (url.includes("/hscp/cwzb/")) return [{ date: "2025-12-31", jzsy: 30, xsjl: 55 }];
      if (url.includes("/hscp/gsjj/")) return { desc: "麦蕊简介" };
      if (url.includes("/hszg/zg/")) return [{ name: "申万行业-食品饮料" }];
      return {};
    },
  });
  mock.method(globalThis, "fetch", fetchMock as unknown as typeof fetch);

  const profile = await getProfile("000004");
  // 麦蕊实时 pe=15.59、pb_ratio=7.2 应成为 PE/PB 的第一优先级
  assert.equal(profile.pe, 15.59, "PE 麦蕊优先");
  assert.equal(profile.pb, 7.2, "PB 麦蕊优先");
  delete process.env.MAIRUI_TOKEN;
});
