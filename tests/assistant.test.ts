import assert from "node:assert/strict";
import test from "node:test";
import { buildFallbackAnswer, summarizeContext, type AssistantContext } from "../lib/ai/assistant";

// 复现大屏浮窗“抽风”根因：现金 344.96 元 + 总仓位 97.88% 时，
// summarizeContext 不得再注入/输出中文大写数字（叁佰肆拾肆元玖角陆分、玖拾柒点捌捌百分比）。
const bigScreenContext: AssistantContext = {
  stock: { code: "002611", name: "东方精工", industry: "通用设备", instrumentType: "stock" },
  quote: {
    price: 16.27,
    changePercent: 0.62,
    ma20: 16.267,
    support: 16.0,
    resistance: 16.38,
    volatility: 2.1,
    marketTime: "2026-08-08T15:00:00+08:00",
  },
  financials: {
    revenueGrowth: null, profitGrowth: null, debtRatio: null, pe: null, pb: null, roe: null,
  },
  summary: "震荡区间，量能缺失，突破未确认",
  risks: ["量能缺失无法验证突破", "单股仓位偏重"],
  missingInformation: ["财务数据缺失"],
  source: { name: "实时行情", fetchedAt: "2026-08-08T15:00:00+08:00" },
  position: {
    quantity: 200,
    averageCost: 16.376,
    returnPercent: -0.65,
    stockPositionPercent: 20.67,
  },
  portfolio: {
    totalAssets: 344.96 / 0.9788, // 使总仓位≈97.88%
    cash: 344.96,
    totalPositionPercent: 97.88,
    totalProfitPercent: null,
    profitPercentNote: "基准失真",
  },
  volume: {
    latest: 1_200_000,
    ma5: 1_000_000,
    ma20: 900_000,
    ratio: 1.2,
    divergence: "无明显背离",
    upDaysWithVolume: 3,
    downDaysWithVolume: 2,
  },
  oscillators: {
    macd: { dif: 0.02, dea: 0.01, hist: 0.02, state: "金叉", divergence: "未知" },
    rsi: { rsi6: 55, rsi12: 52, rsi24: 50, zone: "中性" },
    kdj: { k: 60, d: 55, j: 70, state: "金叉" },
  },
};

// 任何中文大写数字字符（含“百分比”这个中文大写专用后缀）都应被禁止出现
const CHINESE_NUMERAL_RE = /[零壹贰叁肆伍陆柒捌玖拾佰仟万亿角分]|百分比/;

test("summarizeContext 不再输出中文大写数字（大屏抽风根因固化）", () => {
  const text = summarizeContext(bigScreenContext);
  assert.ok(!CHINESE_NUMERAL_RE.test(text), `context 不得含中文大写数字，实际出现：${text.match(CHINESE_NUMERAL_RE)?.[0]}`);
  // 阿拉伯数字须原样保留，不得丢失或变形
  assert.match(text, /344\.96/);
  assert.match(text, /97\.88%/);
  assert.match(text, /16\.27/);
  assert.match(text, /20\.67%/);
});


const context: AssistantContext = {
  stock: { code: "600519", name: "贵州茅台", industry: "白酒", instrumentType: "stock" },
  quote: {
    price: 1500,
    changePercent: 1.2,
    ma20: 1480,
    support: 1400,
    resistance: 1600,
    volatility: 1.8,
    marketTime: "2026-07-29T15:00:00+08:00",
  },
  financials: {
    revenueGrowth: 8,
    profitGrowth: 10,
    debtRatio: 15,
    pe: 22,
    pb: 7,
    roe: 30,
  },
  summary: "价格在20日均线上方，但仍需核验最新公告。",
  risks: ["近期波动可能放大"],
  missingInformation: ["最新公告"],
  source: { name: "腾讯证券", fetchedAt: "2026-07-29T15:01:00+08:00" },
  position: { quantity: 100, averageCost: 1450, returnPercent: 3.45, stockPositionPercent: 18 },
  portfolio: { totalAssets: 200000, cash: 60000, totalPositionPercent: 70, totalProfitPercent: 4 },
};

test("持仓问题会结合用户成本回答", () => {
  const answer = buildFallbackAnswer("结合我的持仓成本怎么看？", context);
  assert.match(answer, /1450\.000/);
  assert.match(answer, /\+3\.45%/);
});

test("风险问题会引用观察线和数据缺口", () => {
  const answer = buildFallbackAnswer("主要风险是什么？", context);
  assert.match(answer, /1400\.000/);
  assert.match(answer, /最新公告/);
});

test("买入问题先检查总仓位和个股集中度", () => {
  const answer = buildFallbackAnswer("现在是否可以买入？", context);
  assert.match(answer, /总仓位70\.00%/);
  assert.match(answer, /仓位层面仍有空间/);
});

test("技术面问题会给出走势结构/支撑阻力/量能动能", () => {
  const answer = buildFallbackAnswer("MACD 和支撑位怎么看？", context);
  assert.match(answer, /支撑¥1400\.000/);
  assert.match(answer, /阻力¥1600\.000/);
  assert.match(answer, /20日均线¥1480\.000/);
  assert.match(answer, /短线结构偏强/);
});

test("持仓占比用成本口径回填时不超过 100% 且标注口径，杜绝 2010% 类爆炸值", () => {
  // 复现生产事故根因：浮窗后端 focus backfill 在拿不到实时市值占比时，改用工信部成本口径
  // （持仓成本/总持仓成本）并标注说明，而不是留 null 让模型自行编造 2010%。
  const costBased: AssistantContext = {
    ...context,
    position: {
      quantity: 100,
      averageCost: 1450,
      returnPercent: null,
      stockPositionPercent: 35.5,
      stockPositionPercentNote: "按成本口径估算(持仓成本/总持仓成本)，非实时市值占比",
    },
  };
  // 后端回填必须携带口径说明，供 AI 注入层如实引用而非自由发挥
  assert.equal(costBased.position?.stockPositionPercentNote, "按成本口径估算(持仓成本/总持仓成本)，非实时市值占比");
  const answer = buildFallbackAnswer("结合我的持仓怎么看？", costBased);
  assert.match(answer, /35\.50%/);
  // 单股占比绝不允许上千%，物理上单股市值不可能超过总资产
  assert.ok(!/2010%|[1-9]\d{3,}%/.test(answer), `不应出现上千%的爆炸占比，实际含匹配：${answer.match(/[1-9]\d{2,}%/g)}`);
});

test("持仓占比基准失真（null）时 fallback 明确提示无法计算，不编造占比", () => {
  // 后端无法算出占比（初始资金/出入金失真）时 stockPositionPercent=null，
  // fallback 必须落到“基准失真”分支，而不是让模型自由发挥成 2010%。
  const distorted: AssistantContext = {
    ...context,
    position: { quantity: 100, averageCost: 1450, returnPercent: 3.45, stockPositionPercent: null },
  };
  const answer = buildFallbackAnswer("现在可以买入加仓吗？", distorted);
  assert.match(answer, /基准失真|无法计算/);
  assert.ok(!/2010%|[1-9]\d{3,}%/.test(answer), "占比失真时不得输出上千%的编造占比");
});

test("基本面缺失时仍以技术面为主给出回答，不拒绝判断", () => {
  const noFund = {
    ...context,
    financials: { revenueGrowth: null, profitGrowth: null, debtRatio: null, pe: null, pb: null, roe: null },
  };
  const answer = buildFallbackAnswer("财务数据说明了什么？", noFund);
  assert.match(answer, /本次没有取到该股的基本面数据/);
  assert.match(answer, /技术面仍可作为主要依据/);
  // 且不会因为财务缺失就空手而归——技术面要点被带出
  assert.match(answer, /支撑¥1400\.000/);
  assert.match(answer, /20日均线¥1480\.000/);
});
