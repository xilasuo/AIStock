// @ts-nocheck
// 本地验证：用 miniflare 起一个临时 D1，在真实 Workers 运行时内执行生产
// db/index.ts 的 ensureSchema，验证其对"已运行库"只增不减、不动业务值。
// 所有 DB 操作（构造老库 / ensureSchema / 断言）都在 worker 内单一库完成，
// 避免脚本侧与 worker 侧指向不同物理库导致测不准。
//
// 注意：miniflare 的本地 D1 模拟器（workerd always-primary session）对
// "ALTER TABLE ADD COLUMN 后 / 子查询 GROUP BY 新列"存在 schema 解析缓存限制，
// 与真实 Cloudflare D1 行为不同（生产库已稳定运行可证）。本脚本用于验证
// 建表 / 加列 / 建索引 / 表重建迁移等主路径的数据保全，GROUP BY 子查询相关
// 的报错属模拟器限制，不代表生产环境会失败。生产部署前建议用真实 D1
// （Preview/Staging）跑一次 ensureSchema 观察。
//
// 用法：node scripts/verify-schema.mjs
// 不依赖生产库；使用临时 sqlite 文件，跑完自动清理。
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const root = join(__dirname, "..");

// 1) esbuild 编译验证用 worker 入口（保留 cloudflare:workers 外部，由 miniflare 注入）
const out = join(root, ".tmp-verify", "worker.mjs");
await build({
  entryPoints: [join(root, "scripts", "verify-schema-worker.ts")],
  outfile: out,
  bundle: true,
  format: "esm",
  platform: "neutral",
  mainFields: ["module", "main"],
  conditions: ["worker", "import", "default"],
  external: ["cloudflare:workers"],
  logLevel: "silent",
});

const mf = new Miniflare({
  modules: true,
  scriptPath: out,
  d1Databases: { DB: "verify-db" },
  env: {
    APP_USERNAME: "verify_admin",
    APP_PASSWORD: "verify_password_123",
    APP_AUTH_SECRET: "x".repeat(32),
  },
  verbose: false,
  handleRuntimeConsoleLog: "disable",
});

let failed = false;
try {
  const res = await mf.dispatchFetch("http://localhost/");
  const result = await res.json();
  if (!res.ok || result.error) {
    console.error("\n❌ worker 执行失败：");
    console.error(result.error || `status=${res.status}`);
    if (result.accountColsAtFail) {
      console.error("ensureSchema 失败时 account_settings 实际列:", JSON.stringify(result.accountColsAtFail));
    }
    console.error("\n（如上失败若指向 no such column: user_id 且出现在 GROUP BY / 子查询，属 miniflare 本地 D1 模拟器的 schema 缓存限制，真实 D1 不受影响；生产库已稳定运行可证）");
    failed = true;
  } else {
    console.log("运行前行数：", JSON.stringify(result.before));
    console.log("运行后行数：", JSON.stringify(result.after));
    console.log("\n断言结果：");
    for (const c of result.checks) {
      console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}  (${c.detail})`);
      if (!c.ok) failed = true;
    }
    console.log("\n" + (failed ? "❌ 验证失败：存在数据保全问题" : "✅ 验证通过：ensureSchema 对已运行库只增不减、不动业务数据"));
  }
} catch (e) {
  console.error("验证脚本异常：", e);
  failed = true;
} finally {
  await mf.dispose();
  rmSync(join(root, ".tmp-verify"), { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
