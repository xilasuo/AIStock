import { sql } from "drizzle-orm";
import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// ─────────────────────────────────────────────────────────────────────────────
// 本文件是「文档镜像」：方案 A 后，drizzle-kit 与 drizzle/ 迁移目录已废弃，
// 真实建表 / 加列 / 建索引的唯一事实源是 db/index.ts 的 ensureSchema() 运行时。
// 本 schema.ts 仅用于：① drizzle ORM 的查询类型推断（getDb 仍传入 schema）；
// ② 作为 ensureSchema 的人工对照文档。任何结构性变更必须同步改 ensureSchema，
// 禁止再运行 drizzle-kit generate（无配置、无迁移目录）。
// ─────────────────────────────────────────────────────────────────────────────

// 多用户账户表（超级管理员在后台增删；普通用户不能自助注册）。
// 密码仅存 PBKDF2 哈希 + 随机 salt，绝不存明文。
export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  salt: text("salt").notNull(),
  displayName: text("display_name").notNull().default(""),
  role: text("role", { enum: ["super_admin", "user"] }).notNull().default("user"),
  disabled: integer("disabled", { mode: "boolean" }).notNull().default(false),
  // 会话版本号：改密 / 禁用 / 改角色时自增，使该用户已签发的 token 立即失效。
  tokenVersion: integer("token_version").notNull().default(0),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({
  // 每次冷启动 ensureSchema 都会 WHERE role = 'super_admin' 检查种子账号。
  roleIdx: index("users_role_idx").on(table.role),
}));

// Keep the original prototype table in the migration graph so existing data is
// never dropped when the new, validated tables are introduced.
export const legacyTrades = sqliteTable("trades", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  symbol: text("symbol").notNull(),
  name: text("name").notNull(),
  side: text("side").notNull(),
  price: real("price").notNull(),
  quantity: integer("quantity").notNull(),
  reason: text("reason").notNull(),
  plan: text("plan").notNull(),
  tradedAt: text("traded_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const tradeRecords = sqliteTable("trade_records", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull().default(0),
  symbol: text("symbol").notNull(),
  name: text("name").notNull(),
  side: text("side", { enum: ["买入", "卖出"] }).notNull(),
  priceCents: integer("price_cents").notNull(),
  priceMillis: integer("price_millis"),
  priceTenThousandths: integer("price_ten_thousandths"),
  quantity: integer("quantity").notNull(),
  tradeDate: text("trade_date").notNull(),
  reason: text("reason").notNull(),
  maxLossCents: integer("max_loss_cents"),
  feeCents: integer("fee_cents").notNull().default(0),
  otherReason: text("other_reason"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at"),
}, (table) => ({
  // 与 ensureSchema 运行时索引逐字一致（现网真实索引为准）。
  userIdx: index("trade_records_user_idx").on(table.userId, table.tradeDate),
}));

export const watchItems = sqliteTable("watch_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull().default(0),
  symbol: text("symbol").notNull(),
  name: text("name").notNull(),
  note: text("note").notNull().default(""),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({
  userSymbolUnique: uniqueIndex("watch_items_user_symbol_idx").on(table.userId, table.symbol),
  userIdx: index("watch_items_user_idx").on(table.userId),
}));

export const watchDetails = sqliteTable("watch_details", {
  symbol: text("symbol").notNull(),
  userId: integer("user_id").notNull().default(0),
  conditionText: text("condition_text").notNull().default("等待自己的买入条件"),
  status: text("status", { enum: ["研究中", "等待条件", "已买入", "暂停"] }).notNull().default("研究中"),
  lastReviewedAt: text("last_reviewed_at"),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  conditionMetric: text("condition_metric"),
  conditionDirection: text("condition_direction"),
  conditionValue: real("condition_value"),
}, (table) => ({
  pk: primaryKey({ columns: [table.symbol, table.userId] }),
  userIdx: index("watch_details_user_idx").on(table.userId, table.symbol),
}));

export const alertRules = sqliteTable("alert_rules", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull().default(0),
  symbol: text("symbol").notNull(),
  name: text("name").notNull(),
  type: text("type", { enum: ["止损", "止盈一", "止盈二"] }).notNull(),
  targetPriceCents: integer("target_price_cents").notNull(),
  targetPriceMillis: integer("target_price_millis"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  acknowledgedAt: text("acknowledged_at"),
  triggeredAt: text("triggered_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({
  // 与 ensureSchema 运行时索引逐字一致。
  userIdx: index("alert_rules_user_idx").on(table.userId),
}));

export const reviews = sqliteTable("reviews", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull().default(0),
  symbol: text("symbol").notNull(),
  name: text("name").notNull(),
  cycleEndTradeId: integer("cycle_end_trade_id"),
  buyReason: text("buy_reason").notNull(),
  sellReason: text("sell_reason").notNull(),
  followedPlan: integer("followed_plan", { mode: "boolean" }).notNull(),
  lesson: text("lesson").notNull(),
  resultCents: integer("result_cents").notNull().default(0),
  tags: text("tags").notNull().default("[]"),
  deviationReason: text("deviation_reason").notNull().default(""),
  /** 关联的策略建议 ID（可选），复盘时可追溯到当时 AI/规则给出的建议 */
  strategySuggestionId: integer("strategy_suggestion_id"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({
  // 与 ensureSchema 运行时索引逐字一致。
  userIdx: index("reviews_user_idx").on(table.userId),
}));

export const analysisReports = sqliteTable("analysis_reports", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull().default(0),
  symbol: text("symbol").notNull(),
  name: text("name").notNull(),
  priceCents: integer("price_cents").notNull(),
  priceMillis: integer("price_millis"),
  marketTime: text("market_time"),
  source: text("source").notNull(),
  mode: text("mode", { enum: ["deepseek", "automatic"] }).notNull(),
  summary: text("summary").notNull(),
  reportJson: text("report_json").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({
  // 与 ensureSchema 运行时索引逐字一致。
  userIdx: index("analysis_reports_user_idx").on(table.userId, table.symbol),
}));

export const announcementNotes = sqliteTable("announcement_notes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull().default(0),
  symbol: text("symbol").notNull(),
  name: text("name").notNull(),
  title: text("title").notNull(),
  sourceUrl: text("source_url").notNull().default(""),
  totalPages: integer("total_pages").notNull().default(0),
  summary: text("summary").notNull(),
  risksJson: text("risks_json").notNull().default("[]"),
  mode: text("mode", { enum: ["deepseek", "automatic"] }).notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({
  userIdx: index("announcement_notes_user_idx").on(table.userId, table.symbol),
}));

export const accountSettings = sqliteTable("account_settings", {
  id: integer("id").primaryKey(),
  userId: integer("user_id").notNull().default(0),
  initialCapitalCents: integer("initial_capital_cents").notNull(),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const capitalFlows = sqliteTable("capital_flows", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull().default(0),
  amountCents: integer("amount_cents").notNull(),
  flowDate: text("flow_date").notNull(),
  note: text("note"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({
  userIdx: index("capital_flows_user_idx").on(table.userId),
}));

export const tradingPreferences = sqliteTable("trading_preferences", {
  id: integer("id").primaryKey(),
  userId: integer("user_id").notNull().default(0),
  /** 操作模式（个人风格）：ultra_short/short/swing/long，注入前端 LLM 与引擎 --mode */
  tradeMode: text("trade_mode").notNull().default("short"),
  riskProfile: text("risk_profile", { enum: ["保守", "平衡", "激进"] }).notNull().default("平衡"),
  maxLossPercent: real("max_loss_percent").notNull().default(2),
  maxConcentrationPercent: real("max_concentration_percent").notNull().default(30),
  maxPositionPercent: real("max_position_percent").notNull().default(70),
  enforceStopLoss: integer("enforce_stop_loss", { mode: "boolean" }).notNull().default(true),
  disciplineNote: text("discipline_note").notNull().default(""),
  stealthMode: integer("stealth_mode", { mode: "boolean" }).notNull().default(false),
  /** 券商佣金费率（万 X，如 2.5 = 万2.5），用于买入/卖出时自动估算手续费 */
  commissionRateTenThousandths: real("commission_rate_ten_thousandths").notNull().default(2.5),
  /** 单笔最低佣金（分；0 = 免5），卖出另计印花税 0.05% */
  minCommissionCents: integer("min_commission_cents").notNull().default(500),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// 用户反馈（对应架构图「用户 → 本项目 → 优化策略」闭环）
// 用户在「策略扫描」页对某只标的/某次信号给出有效/无效评价，供 optimizer 调整权重。
export const strategyFeedback = sqliteTable("strategy_feedback", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull().default(0),
  symbol: text("symbol").notNull(),
  name: text("name").notNull().default(""),
  verdict: text("verdict", { enum: ["有效", "无效"] }).notNull().default("有效"),
  note: text("note").notNull().default(""),
  source: text("source").notNull().default("web"),
  factors: text("factors").notNull().default(""),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({
  // 与 ensureSchema 运行时索引逐字一致。
  userIdx: index("strategy_feedback_user_idx").on(table.userId),
}));

// 策略扫描推送结果（跨机器联动 · 本地 trading_agent 推送 / 云端读取）
// 用 D1 存储而非裸文件：Cloudflare Workers 运行时不允许 handler 任意写文件系统。
export const strategyScan = sqliteTable("strategy_scan", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  payload: text("payload").notNull(),
  userId: integer("user_id"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({
  // 按「用户 + 时间倒序」分页读取扫描结果。
  userIdx: index("strategy_scan_user_idx").on(table.userId, table.createdAt),
}));

// 候选回写信号推送结果（dry-run；真实下单需接入带下单能力的连接器）
export const strategyWriteback = sqliteTable("strategy_writeback", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id"),
  payload: text("payload").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({
  userIdx: index("strategy_writeback_user_idx").on(table.userId, table.createdAt),
}));

// 云端「选股前置条件」配置（网页保存 / 本地 trading_agent 拉取）。
// 与 strategy_scan（扫描结果）分离，避免配置数据污染扫描结果渲染。
// 注意：user_id 可空。NULL 表示「全局默认」行（遗留单条配置 / 管理员维护），
// 作为未单独保存过个人配置用户的回退；非 NULL 则为该登录用户本人隔离的配置。
export const strategyConfig = sqliteTable("strategy_config", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id"),
  payload: text("payload").notNull(),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({
  // 读配置主路径：WHERE user_id = ? ORDER BY updated_at DESC。
  userIdx: index("strategy_config_user_idx").on(table.userId, table.updatedAt),
}));

// 策略建议追踪表：记录每次 AI/规则引擎生成的策略建议，支持用户事后标注结果
// (正确/错误/不确定)，用于统计 AI 准确率与优化迭代。
export const strategySuggestions = sqliteTable("strategy_suggestions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull().default(0),
  symbol: text("symbol").notNull(),
  name: text("name").notNull().default(""),
  /** 最终采纳的动作结论（规则引擎优先，AI 不可用时回退规则） */
  action: text("action", { enum: ["开新仓", "加仓", "持有", "减仓", "清仓", "观望"] }),
  /** 来源：ai=LLM输出, rule=规则引擎兜底, hybrid=AI+规则一致 */
  source: text("source").notNull().default("rule"),
  aiAction: text("ai_action"),
  ruleAction: text("rule_action"),
  /** 0=AI与规则一致, 1=AI与规则分歧, NULL=仅规则引擎 */
  diff: integer("diff"),
  /** 生成建议时的股价 */
  priceAtTime: real("price_at_time"),
  /** 生成时 context 快照（JSON 字符串） */
  contextJson: text("context_json"),
  /** 用户标注结果：pending=待验证, correct=正确, wrong=错误, uncertain=不确定 */
  outcome: text("outcome", { enum: ["pending", "correct", "wrong", "uncertain"] }).notNull().default("pending"),
  outcomeNote: text("outcome_note").notNull().default(""),
  /** 标注时的股价 */
  outcomePrice: real("outcome_price"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  /** 用户标注结果的时间 */
  outcomeAt: text("outcome_at"),
  /** AI 输出数字回验警告（JSON 数组字符串），如 ["[幻觉] 止损价≥现价", ...] */
  validationWarnings: text("validation_warnings").notNull().default(""),
  /** 上下文数据质量总分 0-100 */
  contextQualityScore: integer("context_quality_score"),
}, (table) => ({
  // 主查询：用户 + 时间倒序（最近建议列表）
  userIdx: index("strategy_suggestions_user_idx").on(table.userId, table.createdAt),
  // 按标注状态过滤（待验证列表）
  outcomeIdx: index("strategy_suggestions_outcome_idx").on(table.userId, table.outcome),
}));
