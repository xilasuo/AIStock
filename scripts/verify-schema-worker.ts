// 验证用 worker 入口：在真实 Workers 运行时（miniflare 注入 env.DB）内，
// 构造"老库"结构并插入假数据，执行生产 db/index.ts 的 ensureSchema，
// 然后对比跑前/跑后的行数与结构，验证数据保全。结果以 JSON 返回给脚本侧。
// 本文件仅用于本地验证，不参与部署。
import { ensureSchema } from "../db/index";

export default {
  async fetch(_req: Request): Promise<Response> {
    const db = (globalThis as any).env?.DB ?? (await import("cloudflare:workers")).env.DB;
    const all = (sql: string) => db.prepare(sql).all();
    const run = (sql: string, ...params: any[]) => db.prepare(sql).run(...params);
    const count = async (t: string) => (await all(`SELECT COUNT(*) c FROM ${t}`)).results[0].c;
    const firstRow = async (sql: string) =>
      ((await all(sql)).results[0] as any) ?? null;
    const cols = async (t: string) =>
      ((await all(`PRAGMA table_info(${t})`)).results as any[]).map((r) => r.name);
    const idxList = async (t: string) =>
      ((await all(`PRAGMA index_list(${t})`)).results as any[]).map((r) => r.name);

    const result: any = { before: {}, after: {}, checks: [] };
    const check = (name: string, ok: boolean, detail: string) =>
      result.checks.push({ name, ok, detail });

    try {
      // ── 构造老库（模拟生产运行一段时间后的状态）──
      // miniflare D1 的 batch 接受 statement 数组（直接 db.prepare，不提前 .run()）
      await db.batch([
        db.prepare(`CREATE TABLE users (
          id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, username TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL, salt TEXT NOT NULL, display_name TEXT NOT NULL DEFAULT '',
          role TEXT NOT NULL DEFAULT 'user', disabled INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`),
        db.prepare(`CREATE TABLE trade_records (
          id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, symbol TEXT NOT NULL, name TEXT NOT NULL,
          side TEXT NOT NULL, price_cents INTEGER NOT NULL, quantity INTEGER NOT NULL,
          trade_date TEXT NOT NULL, reason TEXT NOT NULL, fee_cents INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`),
        db.prepare(`CREATE TABLE watch_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, user_id INTEGER NOT NULL DEFAULT 0,
          symbol TEXT NOT NULL, name TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(symbol))`),
        db.prepare(`CREATE TABLE watch_details (
          symbol TEXT NOT NULL, condition_text TEXT NOT NULL DEFAULT 'x', status TEXT NOT NULL DEFAULT '研究中',
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (symbol))`),
        db.prepare(`CREATE TABLE strategy_config (id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`),
        db.prepare(`CREATE TABLE strategy_scan (id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`),
        // 模拟"已运行生产库"：account_settings / trading_preferences 已经过老 ensureSchema，
        // 带 user_id 列与唯一索引（最贴近真实升级场景）
        db.prepare(`CREATE TABLE account_settings (id INTEGER PRIMARY KEY NOT NULL, initial_capital_cents INTEGER NOT NULL, user_id INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`),
        db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS account_settings_user_idx ON account_settings(user_id)`),
        db.prepare(`CREATE TABLE trading_preferences (id INTEGER PRIMARY KEY NOT NULL, risk_profile TEXT NOT NULL DEFAULT '平衡', max_loss_percent REAL NOT NULL DEFAULT 2, user_id INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`),
        db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS trading_preferences_user_idx ON trading_preferences(user_id)`),
      ]);
      await db.batch([
        db.prepare(`INSERT INTO users (username, password_hash, salt, role) VALUES ('existing_admin','h','s','super_admin')`),
        db.prepare(`INSERT INTO trade_records (symbol,name,side,price_cents,quantity,trade_date,reason) VALUES ('600000','浦发银行','买入',1234,100,'2026-01-01','老数据')`),
        db.prepare(`INSERT INTO trade_records (symbol,name,side,price_cents,quantity,trade_date,reason) VALUES ('000001','平安银行','卖出',5678,200,'2026-02-01','老数据2')`),
        db.prepare(`INSERT INTO watch_items (user_id,symbol,name) VALUES (0,'600000','浦发银行')`),
        db.prepare(`INSERT INTO watch_items (user_id,symbol,name) VALUES (0,'000001','平安银行')`),
        db.prepare(`INSERT INTO watch_details (symbol) VALUES ('600000')`),
        db.prepare(`INSERT INTO watch_details (symbol) VALUES ('000001')`),
        db.prepare(`INSERT INTO strategy_config (payload) VALUES ('{"old":1}')`),
        db.prepare(`INSERT INTO strategy_scan (payload) VALUES ('{"old":1}')`),
      ]);

      result.before = {
        users: await count("users"),
        trades: await count("trade_records"),
        watchItems: await count("watch_items"),
        watchDetails: await count("watch_details"),
        strategyConfig: await count("strategy_config"),
        tradeFirst: await firstRow(`SELECT symbol,reason,price_cents FROM trade_records ORDER BY id LIMIT 1`),
      };

      // ── 执行生产 ensureSchema ──
      try {
        await ensureSchema();
      } catch (e) {
        // 捕获后 dump account_settings 实际列，便于定位（若有）
        try {
          const asCols = await cols("account_settings");
          (result as any).accountColsAtFail = asCols;
        } catch {}
        throw e;
      }

      // ── 跑后断言 ──
      result.after = {
        users: await count("users"),
        trades: await count("trade_records"),
        watchItems: await count("watch_items"),
        watchDetails: await count("watch_details"),
        strategyConfig: await count("strategy_config"),
        tradeFirst: await firstRow(`SELECT symbol,reason,price_cents FROM trade_records ORDER BY id LIMIT 1`),
      };

      const b = result.before, a = result.after;
      check("users 行数不变", a.users === b.users, `${b.users}->${a.users}`);
      check("trade_records 行数不变", a.trades === b.trades, `${b.trades}->${a.trades}`);
      check("watch_items 行数不变", a.watchItems === b.watchItems, `${b.watchItems}->${a.watchItems}`);
      check("watch_details 行数不变", a.watchDetails === b.watchDetails, `${b.watchDetails}->${a.watchDetails}`);
      check("strategy_config 行数不变", a.strategyConfig === b.strategyConfig, `${b.strategyConfig}->${a.strategyConfig}`);
      check("trade 首行业务值未变",
        a.tradeFirst.symbol === b.tradeFirst.symbol && a.tradeFirst.reason === b.tradeFirst.reason && a.tradeFirst.price_cents === b.tradeFirst.price_cents,
        JSON.stringify(a.tradeFirst));

      const wdCols = await cols("watch_details");
      check("watch_details 含 user_id（复合主键迁移）", wdCols.includes("user_id"), wdCols.join(","));
      const wdUser = await firstRow(`SELECT user_id FROM watch_details WHERE symbol='600000'`);
      check("watch_details 老数据迁到 user_id=0", !!wdUser && wdUser.user_id === 0, String(wdUser?.user_id));

      const wiCols = await cols("watch_items");
      check("watch_items 含 user_id（复合唯一迁移）", wiCols.includes("user_id"), wiCols.join(","));

      const trCols = await cols("trade_records");
      for (const c of ["price_millis", "price_ten_thousandths", "updated_at", "user_id", "other_reason"]) {
        check(`trade_records 补齐新列 ${c}`, trCols.includes(c), trCols.join(","));
      }

      const adminCount = (await firstRow(`SELECT COUNT(*) c FROM users WHERE role='super_admin'`)).c;
      check("未重复 seed 超管（super_admin=1）", adminCount === 1, `count=${adminCount}`);
      const existing = await firstRow(`SELECT username FROM users WHERE username='existing_admin'`);
      check("原 super_admin 未被覆盖", !!existing && existing.username === "existing_admin", String(existing?.username));

      const trIdx = await idxList("trade_records");
      check("trade_records_user_idx 索引已建", trIdx.some((n: string) => n.includes("trade_records_user_idx")), trIdx.join(","));

      // account_settings / trading_preferences 是否成功加 user_id（修复验证点）
      const asCols = await cols("account_settings");
      check("account_settings 补齐 user_id", asCols.includes("user_id"), asCols.join(","));
      const tpCols = await cols("trading_preferences");
      check("trading_preferences 补齐 user_id", tpCols.includes("user_id"), tpCols.join(","));

      return new Response(JSON.stringify(result), {
        headers: { "content-type": "application/json" },
      });
    } catch (e) {
      const msg = e instanceof Error ? `${e.message}\n${e.stack}` : String(e);
      result.error = msg;
      return new Response(JSON.stringify(result), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
  },
};
