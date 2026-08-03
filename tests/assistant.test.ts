import assert from "node:assert/strict";
import test from "node:test";
import { buildFallbackAnswer, type AssistantContext } from "../lib/assistant";

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
