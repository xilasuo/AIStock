import { test } from "node:test";
import assert from "node:assert/strict";
import {
  generateSalt,
  hashPassword,
  createSessionToken,
  verifyToken,
} from "../lib/auth/crypto";
import { normalizePreferences, DEFAULT_PREFERENCES } from "../lib/utils/preferences";
import { buildTradeCycles, type Trade } from "../lib/domain/domain";

const SECRET = "a".repeat(40); // 满足 >=32 位

function makeTrade(overrides: Partial<Trade> & Pick<Trade, "id" | "symbol" | "side" | "tradeDate">): Trade {
  return {
    name: "测试股",
    priceCents: 1000,
    quantity: 100,
    reason: "",
    maxLossCents: null,
    feeCents: 0,
    ...overrides,
  };
}

test("generateSalt 产生唯一且长度稳定的盐", () => {
  const a = generateSalt();
  const b = generateSalt();
  assert.notEqual(a, b);
  assert.equal(a.length, 22); // 16 字节 -> base64url 无填充
});

test("hashPassword 同密码同盐确定性、不同盐不同结果", async () => {
  const salt = generateSalt();
  const h1 = await hashPassword("S3cret-pass", salt);
  const h2 = await hashPassword("S3cret-pass", salt);
  assert.equal(h1, h2);
  const h3 = await hashPassword("S3cret-pass", generateSalt());
  assert.notEqual(h1, h3);
  // 100k PBKDF2-SHA256 输出 32 字节 -> 43 字符 base64url
  assert.equal(h1.length, 43);
});

test("会话 token 可签发并验证往返", async () => {
  const token = await createSessionToken({ id: 7, username: "alice", role: "user" }, SECRET);
  const user = await verifyToken(token, SECRET);
  assert.ok(user);
  assert.equal(user.id, 7);
  assert.equal(user.username, "alice");
  assert.equal(user.role, "user");
});

test("篡改 token 或错误密钥被拒绝", async () => {
  const token = await createSessionToken({ id: 7, username: "alice", role: "user" }, SECRET);
  const [payload, sig] = token.split(".");
  assert.equal(await verifyToken(`${payload}.${sig}x`, SECRET), null);
  assert.equal(await verifyToken(token, "b".repeat(40)), null);
  assert.equal(await verifyToken("not.a.token", SECRET), null);
});

test("过期 token 被拒绝", async () => {
  const expired = new Date("2020-01-01T00:00:00Z").getTime();
  const token = await createSessionToken({ id: 7, username: "alice", role: "user" }, SECRET, expired);
  assert.equal(await verifyToken(token, SECRET), null);
});

test("normalizePreferences 缺省回落默认且不会串读", () => {
  const p = normalizePreferences(undefined);
  assert.deepEqual(p, DEFAULT_PREFERENCES);
  // 用户 A 无偏好 -> 默认；用户 B 的偏好独立（激进预设默认值生效）
  const b = normalizePreferences({ riskProfile: "激进" });
  assert.equal(b.riskProfile, "激进");
  assert.equal(b.maxLossPercent, 4); // 激进预设默认
  assert.equal(b.enforceStopLoss, false);
  assert.equal(b.disciplineNote, "");
  // A 仍是默认，未被 B 影响
  assert.equal(normalizePreferences(undefined).riskProfile, "平衡");
});

test("normalizePreferences 采纳合法值、回落非法值、截断长备注", () => {
  const p = normalizePreferences({
    riskProfile: "平衡",
    maxLossPercent: -5, // 负值非法 -> 回落预设默认 2
    maxConcentrationPercent: 999, // 超上限 -> 钳到 100
    maxPositionPercent: 50, // 合法 -> 原样保留
    enforceStopLoss: true,
    disciplineNote: "x".repeat(600),
  });
  assert.equal(p.maxLossPercent, 2); // 负值回落预设
  assert.equal(p.maxConcentrationPercent, 100); // 上限
  assert.equal(p.maxPositionPercent, 50); // 合法保留
  assert.equal(p.disciplineNote.length, 500); // 截断
  // 非法 riskProfile 回落平衡
  assert.equal(normalizePreferences({ riskProfile: "未知" as never }).riskProfile, "平衡");
});

test("buildTradeCycles 不同用户交易各自成周期（路由层按 userId 预隔离后）", () => {
  const aliceTrades = [
    makeTrade({ id: 1, symbol: "600000", side: "买入", tradeDate: "2026-01-02" }),
    makeTrade({ id: 2, symbol: "600000", side: "卖出", tradeDate: "2026-01-05" }),
  ];
  const bobTrades = [
    makeTrade({ id: 3, symbol: "600000", side: "买入", tradeDate: "2026-01-03" }),
    makeTrade({ id: 4, symbol: "600000", side: "卖出", tradeDate: "2026-01-06" }),
  ];

  const aliceCycles = buildTradeCycles(aliceTrades);
  const bobCycles = buildTradeCycles(bobTrades);

  assert.equal(aliceCycles.length, 1);
  assert.equal(bobCycles.length, 1);
  assert.deepEqual(aliceCycles[0].trades.map((t) => t.id), [1, 2]);
  assert.deepEqual(bobCycles[0].trades.map((t) => t.id), [3, 4]);
  // 各自的周期仅包含自己的交易，互不含对方 id
  assert.ok(!aliceCycles[0].trades.some((t) => t.id >= 3));
  assert.ok(!bobCycles[0].trades.some((t) => t.id <= 2));
});
