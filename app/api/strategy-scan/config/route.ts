import { requireApiUser, requireApiUserOrPushToken, getAuthenticatedUser } from "../../../../lib/auth/auth";
import { execFileSync } from "child_process";
import type { NextRequest } from "next/server";
import {
  SUPPORTS_EXEC,
  resolvePython,
  isExecNotImplemented,
} from "../../../../lib/utils/pythonExec";
import path from "path";
import { env } from "cloudflare:workers";

/**
 * 计算项目根目录（延迟求值，避免在 Workers/Miniflare 模块顶层
 * 使用 import.meta.url/fileURLToPath 导致 "path must be string" 崩溃）。
 */
function projectRoot(): string {
  return path.resolve(process.cwd(), "../../..");
}

/**
 * 读取当前选股默认配置（strategy_config.yaml 摊平结果）
 *
 * GET /api/strategy-scan/config
 *
 * 返回 trading_agent 的持久默认配置，供前端「策略扫描」面板初始化表单，
 * 使网页与 CLI 共用同一份 strategy_config.yaml。
 *
 * - 真实 Node 部署：直接 exec python dump_config.py 读取最新 YAML（含人工改动）。
 * - Cloudflare Workers / vinext 沙箱（云端部署，禁 child_process）：exec 不可用，
 *   回退到内置默认配置（与 strategy_config.yaml 的默认值保持一致），保证前端
 *   仍可正常配置/展示扫描条件；真正的引擎执行由本地程序拉取该配置后运行。
 */
function dumpScript(): string {
  return path.join(projectRoot(), "trading_agent", "dump_config.py");
}

// 云端持久化配置：前端「保存配置」写入 D1（strategy_config 表，按 user_id 隔离），
// GET 优先读取当前登录用户本人的配置。与 strategy_scan（扫描结果）分离，避免配置
// 污染扫描结果渲染。workerd 沙箱禁止 fs 写入，故使用已挂载持久卷的 D1，容器重建不丢。
//
// 隔离语义：
//  - userId 非 null：读取/写入该登录用户本人配置行。
//  - userId 为 null（仅持共享令牌、无登录身份，或管理员维护全局默认）：
//    读取 user_id IS NULL 的「全局默认」行（即老库遗留单条配置）。
// 读取链：本人配置 -> 全局默认（user_id IS NULL）-> 下方 YAML / FALLBACK_CONFIG。
async function readStoredConfig(userId: number | null): Promise<Record<string, unknown> | null> {
  try {
    if (!env.DB) return null;
    const parse = (payload?: string): Record<string, unknown> | null => {
      if (!payload) return null;
      try {
        const data = JSON.parse(payload);
        return data && typeof data === "object" && "config" in data
          ? (data as { config: Record<string, unknown> }).config
          : (data as Record<string, unknown>);
      } catch {
        return null;
      }
    };
    if (userId != null) {
      const row = (await env.DB.prepare(
        "SELECT payload FROM strategy_config WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1"
      ).bind(userId).first()) as { payload?: string } | null;
      const cfg = parse(row?.payload);
      if (cfg) return cfg;
    }
    // 本人无配置 -> 回退全局默认行（user_id IS NULL）
    const g = (await env.DB.prepare(
      "SELECT payload FROM strategy_config WHERE user_id IS NULL ORDER BY updated_at DESC LIMIT 1"
    ).first()) as { payload?: string } | null;
    return parse(g?.payload);
  } catch {
    return null;
  }
}

async function saveStoredConfig(userId: number | null, config: unknown): Promise<void> {
  if (!env.DB) throw new Error("数据库暂不可用");
  const payload = JSON.stringify({ savedAt: new Date().toISOString(), config });
  // 每用户保留自己最新一行；全局默认行以 user_id IS NULL 标识。
  await env.DB.batch([
    env.DB.prepare("DELETE FROM strategy_config WHERE user_id IS ?").bind(userId),
    env.DB.prepare("INSERT INTO strategy_config (user_id, payload) VALUES (?, ?)").bind(userId, payload),
  ]);
}

// 云端/沙箱回退用的默认配置（与 trading_agent/strategy_config.yaml 默认值同步）。
// 仅用于「配置展示与编辑」，不参与实际选股计算。
const FALLBACK_CONFIG = {
  screener: {
    top_n: 8,
    max_per_sector: 2,
    momentum_window: 20,
    w_momentum: 0.3,
    w_value: 0.18,
    w_liquidity: 0.08,
    w_rsi: 0.12,
    w_macd: 0.12,
    w_trend: 0.16,
    w_size: 0.04,
    w_quality: 0.06,
    rsi_window: 14,
    macd_fast: 12,
    macd_slow: 26,
    macd_signal: 9,
    vol_window: 20,
    min_turnover_pct: 0.15,
    max_pe_ttm: 200.0,
    max_pb: 20.0,
    boards: ["main", "cyb", "kc", "bj"],
    st_filter: "exclude_st",
    mcap_min: 0.0,
    mcap_max: 10000.0,
  },
  market: {
    enable: true,
    index_code: "000300",
    ma_window: 120,
    mom_window: 60,
    bull_ma_gap: 0.0,
    bear_ma_gap: -0.03,
    bull_mom: 0.08,
    bear_mom: -0.05,
  },
  signal: {
    fast_ma: 5,
    slow_ma: 20,
    use_breakout_filter: true,
    breakout_window: 20,
    stop_loss_pct: -0.08,
    max_positions: 8,
  },
  optim: {
    enabled: true,
  },
};

export async function GET(req: Request) {
  const unauthorized = await requireApiUserOrPushToken(req);
  if (unauthorized) return unauthorized;

  // 解析当前登录身份：有会话则取本人配置，仅持共享令牌（无登录身份）则回退全局默认。
  const user = await getAuthenticatedUser();

  // 优先返回该用户本人（或全局默认）已保存的云端配置；读不到才走 exec / 回退默认。
  const stored = await readStoredConfig(user ? user.id : null);
  if (stored) {
    return Response.json({
      ok: true,
      config: stored,
      saved: true,
      scope: user ? "user" : "global",
    });
  }

  if (SUPPORTS_EXEC) {
    try {
      const DUMP = dumpScript();
      const python = resolvePython();
      const stdout = execFileSync(python, [DUMP], {
        cwd: path.join(projectRoot(), "trading_agent"),
        timeout: 15000,
        encoding: "utf-8",
        env: { ...process.env },
      });
      const cfg = JSON.parse(stdout.trim().split("\n").pop() || "{}");
      return Response.json({ ok: true, config: cfg });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      // 沙箱禁 child_process / exec 不可用 -> 回退内置默认配置，保证前端可配置
      if (isExecNotImplemented(msg)) {
        return Response.json({
          ok: true,
          config: FALLBACK_CONFIG,
          note: "云端环境（沙箱）无法读取实时 YAML，已返回内置默认配置。实际选股由本地程序拉取本配置后执行。",
        });
      }
      console.error("[strategy-scan/config] error:", msg);
      return Response.json(
        { ok: false, error: `读取配置失败: ${msg}` },
        { status: 500 },
      );
    }
  }

  // Workers / Miniflare 沙箱 -> 返回内置默认配置
  return Response.json({
    ok: true,
    config: FALLBACK_CONFIG,
    note: "云端环境（沙箱）无法读取实时 YAML，已返回内置默认配置。实际选股由本地程序拉取本配置后执行。",
  });
}

// 保存前端提交的选股前置条件配置到云端持久文件（按当前登录用户隔离写入）。
export async function POST(req: NextRequest) {
  try {
    const unauthorized = await requireApiUser();
    if (unauthorized) return unauthorized;
  } catch {
    return Response.json({ ok: false, error: "未授权" }, { status: 401 });
  }

  const user = await getAuthenticatedUser();
  if (!user) {
    return Response.json({ ok: false, error: "未授权" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const config =
    body && typeof body === "object" && "config" in body
      ? (body as { config: unknown }).config
      : body;

  if (!config || typeof config !== "object") {
    return Response.json({ ok: false, error: "缺少 config 对象" }, { status: 400 });
  }

  try {
    // 保存写入当前登录用户本人隔离行（user_id = 本人 id）。
    await saveStoredConfig(user.id, config);
    return Response.json({ ok: true, saved: true, config });
  } catch (e) {
    return Response.json(
      { ok: false, error: `保存失败: ${String(e)}` },
      { status: 500 }
    );
  }
}
