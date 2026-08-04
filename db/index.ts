import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

let schemaReady: Promise<void> | null = null;

export function getDb() {
  if (!env.DB) {
    throw new Error("数据库暂不可用");
  }
  return drizzle(env.DB, { schema });
}

async function addColumnIfMissing(table: string, column: string, definition: string) {
  const db = env.DB;
  const info = await db.prepare(`PRAGMA table_info(${table})`).all();
  const columns = info.results as Array<{ name?: string }>;
  if (columns.some((item) => item.name === column)) return;

  try {
    await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${definition}`).run();
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (!message.toLowerCase().includes("duplicate column")) throw error;
  }
}

export async function ensureSchema() {
  if (!env.DB) {
    throw new Error("数据库暂不可用");
  }
  if (schemaReady) {
    return schemaReady;
  }

  schemaReady = (async () => {
    const db = env.DB;
    await db.batch([
      db.prepare(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        salt TEXT NOT NULL,
        display_name TEXT NOT NULL DEFAULT '',
        role TEXT NOT NULL DEFAULT 'user',
        disabled INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`),
      db.prepare(`CREATE INDEX IF NOT EXISTS users_username_idx ON users(username)`),
      db.prepare(`CREATE TABLE IF NOT EXISTS trade_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        symbol TEXT NOT NULL,
        name TEXT NOT NULL,
        side TEXT NOT NULL CHECK(side IN ('买入', '卖出')),
        price_cents INTEGER NOT NULL CHECK(price_cents > 0),
        price_millis INTEGER,
        price_ten_thousandths INTEGER,
        quantity INTEGER NOT NULL CHECK(quantity > 0),
        trade_date TEXT NOT NULL,
        reason TEXT NOT NULL,
        max_loss_cents INTEGER,
        fee_cents INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS watch_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        symbol TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS watch_details (
        symbol TEXT NOT NULL,
        user_id INTEGER NOT NULL DEFAULT 0,
        condition_text TEXT NOT NULL DEFAULT '等待自己的买入条件',
        status TEXT NOT NULL DEFAULT '研究中',
        last_reviewed_at TEXT,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        condition_metric TEXT,
        condition_direction TEXT,
        condition_value REAL,
        PRIMARY KEY (symbol, user_id)
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS alert_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        symbol TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('止损', '止盈一', '止盈二')),
        target_price_cents INTEGER NOT NULL CHECK(target_price_cents > 0),
        target_price_millis INTEGER,
        enabled INTEGER NOT NULL DEFAULT 1,
        acknowledged_at TEXT,
        triggered_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        symbol TEXT NOT NULL,
        name TEXT NOT NULL,
        cycle_end_trade_id INTEGER,
        buy_reason TEXT NOT NULL,
        sell_reason TEXT NOT NULL,
        followed_plan INTEGER NOT NULL,
        lesson TEXT NOT NULL,
        result_cents INTEGER NOT NULL DEFAULT 0,
        tags TEXT NOT NULL DEFAULT '[]',
        deviation_reason TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS analysis_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        symbol TEXT NOT NULL,
        name TEXT NOT NULL,
        price_cents INTEGER NOT NULL,
        price_millis INTEGER,
        market_time TEXT,
        source TEXT NOT NULL,
        mode TEXT NOT NULL,
        summary TEXT NOT NULL,
        report_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS announcement_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        symbol TEXT NOT NULL,
        name TEXT NOT NULL,
        title TEXT NOT NULL,
        source_url TEXT NOT NULL DEFAULT '',
        total_pages INTEGER NOT NULL DEFAULT 0,
        summary TEXT NOT NULL,
        risks_json TEXT NOT NULL DEFAULT '[]',
        mode TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS account_settings (
        id INTEGER PRIMARY KEY NOT NULL,
        initial_capital_cents INTEGER NOT NULL CHECK(initial_capital_cents > 0),
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS capital_flows (
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        amount_cents INTEGER NOT NULL,
        flow_date TEXT NOT NULL,
        note TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS trading_preferences (
        id INTEGER PRIMARY KEY NOT NULL,
        risk_profile TEXT NOT NULL DEFAULT '平衡',
        max_loss_percent REAL NOT NULL DEFAULT 2,
        max_concentration_percent REAL NOT NULL DEFAULT 30,
        max_position_percent REAL NOT NULL DEFAULT 70,
        enforce_stop_loss INTEGER NOT NULL DEFAULT 1,
        discipline_note TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`),
      db.prepare("CREATE INDEX IF NOT EXISTS trade_records_symbol_idx ON trade_records(symbol)"),
      db.prepare("CREATE INDEX IF NOT EXISTS alert_rules_symbol_idx ON alert_rules(symbol)"),
      db.prepare("CREATE INDEX IF NOT EXISTS reviews_symbol_idx ON reviews(symbol)"),
      db.prepare("CREATE INDEX IF NOT EXISTS analysis_reports_symbol_idx ON analysis_reports(symbol)"),
      db.prepare("CREATE INDEX IF NOT EXISTS announcement_notes_symbol_idx ON announcement_notes(symbol)"),
      db.prepare(`CREATE TABLE IF NOT EXISTS strategy_feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        symbol TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        verdict TEXT NOT NULL DEFAULT '有效',
        note TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT 'web',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`),
      db.prepare("CREATE INDEX IF NOT EXISTS strategy_feedback_symbol_idx ON strategy_feedback(symbol)"),
      db.prepare(`CREATE TABLE IF NOT EXISTS strategy_scan (
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS strategy_writeback (
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS strategy_config (
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`),
      db.prepare("CREATE INDEX IF NOT EXISTS strategy_scan_created_idx ON strategy_scan(created_at)"),
      db.prepare("CREATE INDEX IF NOT EXISTS strategy_writeback_created_idx ON strategy_writeback(created_at)"),
    ]);
    await addColumnIfMissing("trade_records", "price_millis", "price_millis INTEGER");
    await addColumnIfMissing("trade_records", "price_ten_thousandths", "price_ten_thousandths INTEGER");
    await addColumnIfMissing("alert_rules", "target_price_millis", "target_price_millis INTEGER");
    await addColumnIfMissing("alert_rules", "triggered_at", "triggered_at TEXT");
    await addColumnIfMissing("watch_details", "condition_metric", "condition_metric TEXT");
    await addColumnIfMissing("watch_details", "condition_direction", "condition_direction TEXT");
    await addColumnIfMissing("watch_details", "condition_value", "condition_value REAL");
    await addColumnIfMissing("trade_records", "other_reason", "other_reason TEXT");
    await addColumnIfMissing("analysis_reports", "price_millis", "price_millis INTEGER");
    await addColumnIfMissing("reviews", "tags", "tags TEXT NOT NULL DEFAULT '[]'");
    await addColumnIfMissing("reviews", "deviation_reason", "deviation_reason TEXT NOT NULL DEFAULT ''");
    // 操作时间：交易记录最后修改时间（PATCH 更新时写回；老数据回填为创建时间）
    await addColumnIfMissing("trade_records", "updated_at", "updated_at TEXT");
    await db.prepare("UPDATE trade_records SET updated_at = created_at WHERE updated_at IS NULL").run();

    // 隐身模式开关（办公室低存在感配色）
    await addColumnIfMissing("trading_preferences", "stealth_mode", "stealth_mode INTEGER NOT NULL DEFAULT 0");

    // ---- 多用户隔离迁移 ----
    // 1) 给所有用户数据表加 user_id 列（老表兼容，默认 0 表示尚未归属）
    for (const table of [
      "trade_records", "watch_items", "alert_rules", "reviews",
      "analysis_reports", "announcement_notes", "account_settings",
      "capital_flows", "trading_preferences", "strategy_feedback",
    ]) {
      await addColumnIfMissing(table, "user_id", "user_id INTEGER NOT NULL DEFAULT 0");
    }

    // 1.5) 单例配置表（账户设置 / 风险偏好）按 user_id 建立唯一索引，
    // 支撑 account/preferences 路由的 onConflictDoUpdate（UPSERT）。
    // 先去重（保留每用户最小 id 的一行），避免老库存在重复行导致建索引失败。
    for (const table of ["account_settings", "trading_preferences"]) {
      await db.batch([
        db.prepare(
          `DELETE FROM ${table} WHERE id NOT IN (SELECT MIN(id) FROM ${table} GROUP BY user_id)`,
        ),
      ]);
    }

    // 1.6) 选股前置条件配置表按用户隔离：加可空 user_id 列。
    // 老库遗留的单条全局配置 user_id 为 NULL，自动成为「全局默认」回退；
    // 各登录用户保存自己的配置时 user_id = 本人 id，互不覆盖。
    await addColumnIfMissing("strategy_config", "user_id", "user_id INTEGER");

    // 1.7) 选股结果推送表按用户隔离：加可空 user_id 列。
    // 老库遗留的扫描结果（由共享令牌推送）user_id 为 NULL，自动成为「全局默认」回退；
    // 以登录会话推送的结果 user_id = 本人 id，前端「策略扫描」页按登录用户只展示本人结果。
    await addColumnIfMissing("strategy_scan", "user_id", "user_id INTEGER");

    // 1.8) 候选回写结果推送表按用户隔离：加可空 user_id 列。
    // 老库遗留的回写结果（由共享令牌推送）user_id 为 NULL，自动成为「全局默认」回退；
    // 以登录会话推送的结果 user_id = 本人 id，前端「回写结果」页按登录用户只展示本人结果。
    await addColumnIfMissing("strategy_writeback", "user_id", "user_id INTEGER");

    // 1.9) 用户反馈表：增加 factors 列，存储被评价标的的因子贡献明细，
    // 供 optimizer 计算「哪些因子在用户认可的信号里更重要」，反向调整权重。
    await addColumnIfMissing("strategy_feedback", "factors", "factors TEXT NOT NULL DEFAULT ''");

    await db.batch([
      db.prepare(
        `CREATE UNIQUE INDEX IF NOT EXISTS account_settings_user_idx ON account_settings(user_id)`,
      ),
      db.prepare(
        `CREATE UNIQUE INDEX IF NOT EXISTS trading_preferences_user_idx ON trading_preferences(user_id)`,
      ),
    ]);

    // 2) watch_details 老表（单列 symbol 主键）迁移到复合主键 (symbol, user_id)
    const wdInfo = await db.prepare(`PRAGMA table_info(watch_details)`).all();
    const wdColumns = wdInfo.results as Array<{ name?: string }>;
    if (wdColumns.length > 0 && !wdColumns.some((c) => c.name === "user_id")) {
      await db.batch([
        db.prepare(`CREATE TABLE watch_details_new (
          symbol TEXT NOT NULL,
          user_id INTEGER NOT NULL DEFAULT 0,
          condition_text TEXT NOT NULL DEFAULT '等待自己的买入条件',
          status TEXT NOT NULL DEFAULT '研究中',
          last_reviewed_at TEXT,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          condition_metric TEXT,
          condition_direction TEXT,
          condition_value REAL,
          PRIMARY KEY (symbol, user_id)
        )`),
        db.prepare(`INSERT INTO watch_details_new (symbol, user_id, condition_text, status, last_reviewed_at, updated_at, condition_metric, condition_direction, condition_value)
          SELECT symbol, 0, condition_text, status, last_reviewed_at, updated_at, condition_metric, condition_direction, condition_value FROM watch_details`),
        db.prepare(`DROP TABLE watch_details`),
        db.prepare(`ALTER TABLE watch_details_new RENAME TO watch_details`),
      ]);
    }

    // 3) 首次启动：若 users 表为空，则用环境变量 seed 一个超级管理员
    const existingUsers = await db.prepare(`SELECT COUNT(*) AS count FROM users`).all();
    const userCount = Number((existingUsers.results as Array<{ count?: number }>)[0]?.count ?? 0);
    let adminId = 1;
    if (userCount === 0) {
      const runtimeEnv = env as unknown as {
        APP_USERNAME?: string;
        APP_PASSWORD?: string;
        APP_AUTH_SECRET?: string;
      };
      const seedUsername = (runtimeEnv.APP_USERNAME ?? "admin").trim();
      const seedPassword = runtimeEnv.APP_PASSWORD ?? "";
      if (seedPassword.length < 12) {
        throw new Error(
          "首次启动必须设置 APP_USERNAME 与 APP_PASSWORD(≥12位) 以初始化超级管理员账户",
        );
      }
      const salt = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(16)));
      const passwordHash = await pbkdf2Hash(seedPassword, salt);
      const insertResult = await db.prepare(
        `INSERT INTO users (username, password_hash, salt, display_name, role, disabled, created_at)
         VALUES (?, ?, ?, ?, 'super_admin', 0, CURRENT_TIMESTAMP)`,
      ).bind(seedUsername, passwordHash, salt, seedUsername).run();
      adminId = Number(insertResult.meta?.last_row_id ?? 1);
    } else {
      const adminRow = await db.prepare(
        `SELECT id FROM users WHERE role = 'super_admin' AND disabled = 0 ORDER BY id ASC LIMIT 1`,
      ).all();
      const existingAdmin = (adminRow.results as Array<{ id?: number }>)[0]?.id;
      if (existingAdmin != null) {
        adminId = Number(existingAdmin);
      } else {
        // 库里已有用户但尚无超级管理员：自动把 APP_USERNAME 指定账号
        // （找不到则取 id 最小的账号）提升为 super_admin，避免老库永远停留在普通用户态
        const runtimeEnv = env as unknown as { APP_USERNAME?: string };
        const targetUsername = (runtimeEnv.APP_USERNAME ?? "").trim();
        let promoteId: number | null = null;
        if (targetUsername) {
          const targetRow = await db.prepare(
            `SELECT id FROM users WHERE username = ? AND disabled = 0 ORDER BY id ASC LIMIT 1`,
          ).bind(targetUsername).all();
          promoteId = (targetRow.results as Array<{ id?: number }>)[0]?.id ?? null;
        }
        if (promoteId == null) {
          const firstRow = await db.prepare(
            `SELECT id FROM users WHERE disabled = 0 ORDER BY id ASC LIMIT 1`,
          ).all();
          promoteId = (firstRow.results as Array<{ id?: number }>)[0]?.id ?? 1;
        }
        await db.prepare(
          `UPDATE users SET role = 'super_admin' WHERE id = ?`,
        ).bind(promoteId).run();
        adminId = Number(promoteId);
      }
    }

    // 4) 把老数据（user_id = 0）归属到超级管理员，实现平滑兼容
    await db.batch([
      db.prepare(`UPDATE trade_records SET user_id = ? WHERE user_id = 0`).bind(adminId),
      db.prepare(`UPDATE watch_items SET user_id = ? WHERE user_id = 0`).bind(adminId),
      db.prepare(`UPDATE watch_details SET user_id = ? WHERE user_id = 0`).bind(adminId),
      db.prepare(`UPDATE alert_rules SET user_id = ? WHERE user_id = 0`).bind(adminId),
      db.prepare(`UPDATE reviews SET user_id = ? WHERE user_id = 0`).bind(adminId),
      db.prepare(`UPDATE analysis_reports SET user_id = ? WHERE user_id = 0`).bind(adminId),
      db.prepare(`UPDATE announcement_notes SET user_id = ? WHERE user_id = 0`).bind(adminId),
      db.prepare(`UPDATE account_settings SET user_id = ? WHERE user_id = 0`).bind(adminId),
      db.prepare(`UPDATE capital_flows SET user_id = ? WHERE user_id = 0`).bind(adminId),
      db.prepare(`UPDATE trading_preferences SET user_id = ? WHERE user_id = 0`).bind(adminId),
      db.prepare(`UPDATE strategy_feedback SET user_id = ? WHERE user_id = 0`).bind(adminId),
      // 单例表（id=1）确保归属超级管理员
      db.prepare(`UPDATE account_settings SET user_id = ? WHERE id = 1`).bind(adminId),
      db.prepare(`UPDATE trading_preferences SET user_id = ? WHERE id = 1`).bind(adminId),
    ]);
  })().catch((error) => {
    schemaReady = null;
    throw error;
  });

  return schemaReady;
}

// 与 lib/auth.ts 保持一致：PBKDF2(SHA-256, 100k) 哈希，用于 seed 超级管理员。
async function pbkdf2Hash(password: string, salt: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: encoder.encode(salt), iterations: 100_000, hash: "SHA-256" },
    keyMaterial,
    256,
  );
  return bytesToBase64Url(new Uint8Array(bits));
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
