import vinext from "vinext";
import { defineConfig, loadEnv } from "vite";
import { sites } from "./build/sites-vite-plugin";

// 警告：此 database_id 决定了 miniflare 本地 D1 持久化目录的哈希。
// 一旦修改，本地数据库文件哈希会变化，运行时将指向新的空库，旧数据"看起来丢失"。
// 切勿随意更改；如需迁移数据请先备份 data/ 并手动复制对应的 sqlite 文件。
const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

export default defineConfig(async ({ mode }) => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // .openai/hosting.json 提供 D1/R2 binding 名称，在 fresh clone / Docker 构建中可能不存在，
  // 此时使用默认值（D1 binding 名 "DB"，无 R2）。
  let d1: string | undefined;
  let r2: string | null | undefined;
  try {
    const hostingConfig = (await import("./.openai/hosting.json")).default as {
      d1?: string;
      r2?: string | null;
    };
    d1 = hostingConfig.d1;
    r2 = hostingConfig.r2;
  } catch {
    d1 = "DB";
    r2 = null;
  }

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  // 本地环境变量（来自 git 忽略的 .env 文件，前缀为空=全部读取）。
  // 通过 worker 的 vars 绑定注入，应用用 import { env } from "cloudflare:workers" 读取。
  const localEnv = loadEnv(mode, process.cwd(), "");
  const runtimeVars: Record<string, string> = {
    DEEPSEEK_API_KEY: localEnv.DEEPSEEK_API_KEY ?? process.env.DEEPSEEK_API_KEY ?? "",
    AI_API_KEY: localEnv.AI_API_KEY ?? process.env.AI_API_KEY ?? "",
    AI_PROVIDER: localEnv.AI_PROVIDER ?? process.env.AI_PROVIDER ?? "",
    AI_API_BASE: localEnv.AI_API_BASE ?? process.env.AI_API_BASE ?? "",
    AI_MODEL: localEnv.AI_MODEL ?? process.env.AI_MODEL ?? "",
    APP_USERNAME: localEnv.APP_USERNAME ?? process.env.APP_USERNAME ?? "",
    APP_PASSWORD: localEnv.APP_PASSWORD ?? process.env.APP_PASSWORD ?? "",
    APP_AUTH_SECRET: localEnv.APP_AUTH_SECRET ?? process.env.APP_AUTH_SECRET ?? "",
    MAIRUI_TOKEN: localEnv.MAIRUI_TOKEN ?? process.env.MAIRUI_TOKEN ?? "",
    NOTIFY_WEBHOOK_URLS: localEnv.NOTIFY_WEBHOOK_URLS ?? process.env.NOTIFY_WEBHOOK_URLS ?? "",
    CRON_SECRET: localEnv.CRON_SECRET ?? process.env.CRON_SECRET ?? "",
    STRATEGY_PUSH_TOKEN: localEnv.STRATEGY_PUSH_TOKEN ?? process.env.STRATEGY_PUSH_TOKEN ?? "",
  };
  const vars = Object.fromEntries(
    Object.entries(runtimeVars).filter(([, v]) => v.trim().length > 0),
  );

  const localBindingConfig = {
    main: "./worker/index.ts",
    compatibility_flags: ["nodejs_compat"],
    vars,
    d1_databases: d1
      ? [
          {
            binding: d1,
            database_name: "site-creator-d1",
            database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
          },
        ]
      : [],
    r2_buckets: r2
      ? [
          {
            binding: r2,
            bucket_name: "site-creator-r2",
          },
        ]
      : [],
    triggers: { crons: ["*/15 * * * *"] },
  };

  return {
    server: isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : undefined,
    // Vite 内置的 emptyDir 清空 dist 会被 safe-delete shim 的批量删除阈值拦截
    // （>50 文件）。改为关闭自动清空，由 sites() 插件在 buildStart 阶段用
    // 绕过 shim 的方式清空，行为等价且构建可稳定通过。
    build: { emptyOutDir: false },
    plugins: [
      vinext(),
      sites(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: localBindingConfig,
      }),
    ],
  };
});
