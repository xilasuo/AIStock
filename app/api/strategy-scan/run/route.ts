import { requireApiUser } from "../../../../lib/auth";
import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import {
  SUPPORTS_EXEC,
  resolvePython,
  isExecNotImplemented,
} from "../../../../lib/pythonExec";
import path from "path";

/**
 * 计算项目根目录（延迟求值，避免在 Workers/Miniflare 模块顶层
 * 使用 import.meta.url/fileURLToPath 导致 "path must be string" 崩溃）。
 *
 * 容器内 wrangler 运行时 cwd 为 /app/dist/server，trading_agent 在 /app，
 * 故向上三层即为项目根；本地真实 Node 部署同样适用。
 */
function projectRoot(): string {
  return path.resolve(process.cwd(), "../../..");
}

/**
 * 交互式选股扫描接口
 *
 * POST /api/strategy-scan/run
 *
 * 接收前端传来的选股配置覆盖参数（权重/阈值/板块/ST/市值等），
 * 调用 trading_agent/run_hub.py 以新配置重新跑引擎，返回扫描结果。
 *
 * 运行环境说明：
 *   - 真实 Node（本地 `node` 原生部署）：直接 exec python run_hub.py。
 *   - Cloudflare Workers / vinext dev(Miniflare) 沙箱：无法直接 exec，
 *     会把请求转发给本机真实 Node 守护进程（npm run engine）执行。
 *
 * Body (JSON, 所有字段可选): 见下方 ALLOWED_KEYS 白名单。
 */

// 允许前端传递的字段白名单（安全边界）
const ALLOWED_KEYS = new Set([
  // 策略预设（配方名，由后端解析为权重/阈值基线）
  "preset",
  // screener
  "top_n", "max_per_sector", "momentum_window",
  "w_momentum", "w_value", "w_liquidity", "w_rsi", "w_macd", "w_trend", "w_size", "w_quality",
  "w_fund_flow",
  "rsi_window", "macd_fast", "macd_slow", "macd_signal", "vol_window",
  "min_turnover_pct", "max_pe_ttm", "max_pb",
  "boards", "st_filter", "mcap_min", "mcap_max",
  // signal
  "fast_ma", "slow_ma", "use_breakout_filter", "breakout_window", "stop_loss_pct", "max_positions",
  // market
  "market_enable", "index_code", "ma_window", "mom_window", "short_mom_window",
  "bull_ma_gap", "bear_ma_gap", "bull_mom", "bear_mom",
  "strong_short_mom", "weak_short_mom", "vol_shrink_threshold",
  "neutral_up_factor", "neutral_down_factor",
  // optim
  "optim_enabled",
]);

function sanitizeOverrides(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (ALLOWED_KEYS.has(k) && v !== null && v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

export async function POST(req: Request) {
  const unauthorized = await requireApiUser();
  if (unauthorized) return unauthorized;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
    if (!body || typeof body !== "object") body = {};
  } catch {
    body = {};
  }

  const overrides = sanitizeOverrides(body);
  const overridesStr = JSON.stringify(overrides);

  // 路径 A：真实 Node 运行时，直接执行
  if (SUPPORTS_EXEC) {
    try {
      const PROJECT_ROOT = projectRoot();
      const PREFETCHED = path.join(PROJECT_ROOT, "trading_agent", "prefetched.json");
      const RUN_HUB = path.join(PROJECT_ROOT, "trading_agent", "run_hub.py");
      const SCAN_PAYLOAD = path.join(PROJECT_ROOT, "trading_agent", "scan_payload.json");
      const python = resolvePython();
      const stdout = execFileSync(
        python,
        [RUN_HUB, "--prefetched", PREFETCHED, "--overrides", overridesStr],
        {
          cwd: path.join(PROJECT_ROOT, "trading_agent"),
          timeout: 60_000, // 60s 超时（含回测+优化）
          encoding: "utf-8",
          env: { ...process.env },
        },
      );

      const payload = JSON.parse(readFileSync(SCAN_PAYLOAD, "utf-8"));

      return Response.json({
        ok: true,
        scan: payload,
        appliedOverrides: overrides,
        engineLog: stdout.slice(-200),
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      // 沙箱禁 child_process / exec 不可用：云端不执行引擎，返回明确提示。
      // 真正的选股由本地程序拉取云端配置（GET /api/strategy-scan/config）后运行。
      if (isExecNotImplemented(msg)) {
        return Response.json(
          {
            ok: false,
            code: "CLOUD_ENGINE_DISABLED",
            error:
              "云端环境不执行选股引擎。请在本地程序中使用「拉取云端配置」后运行；或于本地部署时启用本地引擎。",
          },
          { status: 400 },
        );
      }
      console.error("[strategy-scan/run] error:", msg);
      return Response.json(
        { ok: false, error: `引擎执行失败: ${msg}` },
        { status: 500 },
      );
    }
  }

  // 路径 B：Workers / 边缘运行时（沙箱）-> 云端不执行引擎，返回明确提示
  return Response.json(
    {
      ok: false,
      code: "CLOUD_ENGINE_DISABLED",
      error:
        "云端环境不执行选股引擎。请在本地程序中使用「拉取云端配置」后运行；或于本地部署时启用本地引擎。",
    },
    { status: 400 },
  );
}
