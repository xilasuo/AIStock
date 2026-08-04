#!/usr/bin/env -S npx tsx
// 一次性脚本：把历史记录里 symbol 命中 A_STOCK_LIST 的行，name 刷成官方名称。
//
// 运行环境：项目容器内的 wrangler 本地运行时（D1 持久化在 /data）。
// 必须在 wrangler dev（app 容器）停止时运行，否则会与 SQLite 写锁冲突。
//
// 在服务器项目目录下：
//   1) 预演（只看影响，不修改）：
//      docker compose stop fupanbu
//      docker compose run --rm -w /app -e DRY_RUN=1 fupanbu npx tsx scripts/fix-stock-names.ts
//   2) 确认无误后真正执行：
//      docker compose run --rm -w /app fupanbu npx tsx scripts/fix-stock-names.ts
//   3) 重启服务：
//      docker compose up -d
import A_STOCK_LIST from "../db/seeds/a_stock_list";
import { spawnSync } from "node:child_process";

const DB_NAME = "site-creator-d1";
const CONFIG = "/app/dist/server/wrangler.json";
const PERSIST = "/data";
const DRY_RUN = process.env.DRY_RUN === "1";

// 所有同时含 symbol + name 的表
const TABLES = [
  "trade_records",
  "watch_items",
  "alert_rules",
  "reviews",
  "analysis_reports",
  "announcement_notes",
];

type Row = Record<string, unknown>;

function runSql(sql: string): Row[] {
  const res = spawnSync(
    "npx",
    ["wrangler", "d1", "execute", DB_NAME, "--local", "--config", CONFIG, "--persist-to", PERSIST, "--json", "--command", sql],
    { encoding: "utf-8" },
  );
  if (res.status !== 0) {
    throw new Error(`wrangler 执行失败 (${res.status}):\n${res.stderr || res.stdout}`);
  }
  try {
    const data = JSON.parse(res.stdout);
    const result = Array.isArray(data.result) ? data.result[0] : data;
    return result?.results ?? [];
  } catch {
    return [];
  }
}

function escapeSql(value: string): string {
  return value.replace(/'/g, "''");
}

let totalUpdated = 0;
for (const table of TABLES) {
  const rows = runSql(`SELECT DISTINCT symbol FROM ${table}`);
  const symbols = rows.map((r) => String(r.symbol)).filter(Boolean);
  const toUpdate = symbols.filter((s) => A_STOCK_LIST[s]);
  if (toUpdate.length === 0) {
    console.log(`✓ ${table}: 无需要更新的名称`);
    continue;
  }

  if (DRY_RUN) {
    console.log(`(dry-run) ${table}: 将更新 ${toUpdate.length} 行 -> ${toUpdate.join(", ")}`);
    totalUpdated += toUpdate.length;
    continue;
  }

  const whenClauses = toUpdate
    .map((s) => `WHEN '${s}' THEN '${escapeSql(A_STOCK_LIST[s])}'`)
    .join(" ");
  const inList = toUpdate.map((s) => `'${s}'`).join(", ");
  const sql = `UPDATE ${table} SET name = CASE symbol ${whenClauses} END WHERE symbol IN (${inList})`;
  runSql(sql);
  totalUpdated += toUpdate.length;
  console.log(`✓ ${table}: 已更新 ${toUpdate.length} 行`);
}

console.log(`\n${DRY_RUN ? "[预演] " : ""}完成，共涉及 ${totalUpdated} 行名称。`);
if (DRY_RUN) console.log("上述为预演结果，未做修改。去掉 DRY_RUN=1 后重新运行才会真正写入。");
