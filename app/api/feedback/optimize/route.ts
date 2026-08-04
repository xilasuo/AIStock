import { requireApiUser, getAuthenticatedUser } from "../../../../lib/auth/auth";
import { env } from "cloudflare:workers";

/**
 * 反馈优化端点（对应架构图「用户反馈 → 优化策略」闭环的关键一环）
 *
 * POST /api/feedback/optimize
 *
 * 读取当前登录用户的历史反馈（含被评价标的的因子贡献明细），
 * 计算「哪些因子在用户认可(有效)的信号里更突出」，据此对因子权重做温和倾斜，
 * 把结果写回云端 strategy_config（user_id 隔离）。run_hub 拉取云端配置时
 * 自动应用新权重，无需改动 Python 引擎。
 *
 * 设计要点：
 * - 仅做温和倾斜（乘子 clamp 0.5~2.0），避免单条反馈把权重拉爆。
 * - 样本不足（<3 条带因子数据的反馈）则不调整，原样返回提示。
 * - 基础权重优先取用户已保存的云端配置，回退到内置默认。
 */

const FACTOR_KEYS = [
  "momentum",
  "rsi",
  "macd",
  "trend",
  "value",
  "liquidity",
  "size",
  "quality",
  "fund_flow",
] as const;

// 与 trading_agent/config.py 默认权重保持一致（w_fund_flow 取保守默认）。
const FALLBACK_SCREENER: Record<string, number> = {
  w_momentum: 0.3,
  w_value: 0.18,
  w_liquidity: 0.08,
  w_rsi: 0.12,
  w_macd: 0.12,
  w_trend: 0.16,
  w_size: 0.04,
  w_quality: 0.06,
  w_fund_flow: 0.05,
};

type FactorMap = Record<string, number>;

function avg(arr: unknown[]): number | null {
  const v = arr.filter((x) => typeof x === "number" && !Number.isNaN(x)) as number[];
  if (!v.length) return null;
  return v.reduce((a, b) => a + b, 0) / v.length;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

export async function POST(req: Request) {
  const unauthorized = await requireApiUser();
  if (unauthorized) return unauthorized;

  try {
    const user = await getAuthenticatedUser();
    if (!user) return Response.json({ ok: false, error: "未授权" }, { status: 401 });
    if (!env.DB) return Response.json({ ok: false, error: "数据库暂不可用" }, { status: 500 });

    // 目标档位（盘前/盘中/盘后），决定优化哪一档的因子权重
    const PROFILES = ["pre_market", "intraday", "post_market"];
    let profile = "pre_market";
    try {
      const body = (await req.json()) as { profile?: string };
      if (typeof body.profile === "string" && PROFILES.includes(body.profile)) profile = body.profile;
    } catch {
      /* 无 body 则用默认 pre_market */
    }

    // 1) 读该用户反馈（含因子明细）
    const fb = (await env.DB.prepare(
      "SELECT verdict, factors FROM strategy_feedback WHERE user_id = ?",
    ).bind(user.id).all()) as { results: Array<{ verdict: string; factors?: string }> };
    const rows = fb.results || [];

    const up: FactorMap[] = [];
    const down: FactorMap[] = [];
    for (const r of rows) {
      if (!r.factors) continue;
      let f: FactorMap;
      try {
        f = JSON.parse(r.factors);
      } catch {
        continue;
      }
      if (!f || typeof f !== "object") continue;
      (r.verdict === "无效" ? down : up).push(f);
    }
    const total = up.length + down.length;
    if (total < 3) {
      return Response.json({
        ok: true,
        adjusted: false,
        usedFeedback: total,
        note: `反馈样本不足（需≥3条带因子数据的评价，当前${total}条），暂未调整权重。多标记几只「有效/无效」信号后再试。`,
      });
    }

    // 2) 读当前云端配置（本人优先，回退全局默认），支持分档 profiles 结构
    const cfgRow = (await env.DB.prepare(
      "SELECT payload FROM strategy_config WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1",
    ).bind(user.id).first()) as { payload?: string } | null;
    let config: Record<string, unknown> | null = cfgRow?.payload
      ? (JSON.parse(cfgRow.payload) as Record<string, unknown>)
      : null;
    if (config && typeof config.config === "object") config = config.config as Record<string, unknown>;

    // 目标档位：从 profiles 结构取该档；旧全局结构视为 pre_market 档
    const profiles = (config && typeof config.profiles === "object")
      ? (config.profiles as Record<string, unknown>)
      : null;
    const targetRaw = profiles
      ? (profiles[profile] as Record<string, unknown> | undefined)
      : (profile === "pre_market" ? config : null);
    const screenerCfg = (targetRaw?.screener as Record<string, unknown> | undefined) || {};

    const base: FactorMap = {};
    for (const k of FACTOR_KEYS) {
      const w = screenerCfg[`w_${k}`];
      base[k] = typeof w === "number" && w > 0 ? w : (FALLBACK_SCREENER[`w_${k}`] ?? 0.05);
    }

    // 3) 计算各因子在「有效」vs「无效」组的均值，得温和乘子
    const meanAll: FactorMap = {};
    for (const k of FACTOR_KEYS) meanAll[k] = avg([...up, ...down].map((f) => f[k])) ?? 0;
    const meanUp: FactorMap = {};
    const meanDown: FactorMap = {};
    for (const k of FACTOR_KEYS) {
      const a = avg(up.map((f) => f[k]));
      const b = avg(down.map((f) => f[k]));
      meanUp[k] = a ?? meanAll[k];
      meanDown[k] = b ?? meanAll[k];
    }

    const multipliers: FactorMap = {};
    for (const k of FACTOR_KEYS) {
      const a = meanUp[k];
      const b = meanDown[k];
      if (a == null || b == null || b <= 0) {
        multipliers[k] = 1;
        continue;
      }
      const ratio = a / b; // >1：有效股该因子更突出 → 提升权重
      // 对数压缩避免极值，再 clamp 到 0.5~2.0
      const m = clamp(Math.exp(Math.log(clamp(ratio, 0.2, 5)) * 0.5), 0.5, 2.0);
      multipliers[k] = Math.round(m * 1000) / 1000;
    }

    const newW: FactorMap = {};
    for (const k of FACTOR_KEYS) {
      const w = clamp(base[k] * multipliers[k], 0.02, 0.6);
      newW[`w_${k}`] = Math.round(w * 10000) / 10000;
    }

    // 4) 写回云端 strategy_config（删除本人行后插入，与 saveStoredConfig 同语义）
    const newConfig: Record<string, unknown> =
      config && typeof config === "object" ? JSON.parse(JSON.stringify(config)) : {};
    if (newConfig.profiles && typeof newConfig.profiles === "object") {
      // 分档结构：只更新目标档的 screener 权重，不影响其他档
      const ps = newConfig.profiles as Record<string, unknown>;
      const tgt = (ps[profile] as Record<string, unknown> | undefined) || {};
      ps[profile] = { ...tgt, screener: { ...(tgt.screener as object), ...newW } };
    } else if (profile === "pre_market") {
      // 旧全局结构 + 盘前档：直接更新顶层 screener
      newConfig.screener = { ...(newConfig.screener as object), ...newW };
    } else {
      // 旧全局结构 + 非盘前档：包装成三档（原结构作 pre_market，新档写入权重）
      newConfig.profiles = {
        pre_market: config && typeof config === "object" ? config : { screener: {} },
        [profile]: { screener: { ...newW } },
      };
      delete (newConfig as Record<string, unknown>).screener;
    }
    const payload = JSON.stringify({
      savedAt: new Date().toISOString(),
      optimizedFromFeedback: { count: total, up: up.length, down: down.length, profile },
      config: newConfig,
    });
    await env.DB.batch([
      env.DB.prepare("DELETE FROM strategy_config WHERE user_id = ?").bind(user.id),
      env.DB.prepare("INSERT INTO strategy_config (user_id, payload) VALUES (?, ?)").bind(user.id, payload),
    ]);

    const profileLabel = profile === "pre_market" ? "盘前" : profile === "intraday" ? "盘中" : "盘后";
    return Response.json({
      ok: true,
      adjusted: true,
      usedFeedback: total,
      up: up.length,
      down: down.length,
      profile,
      multipliers,
      baseWeights: base,
      newWeights: newW,
      note: `已根据你的 ${total} 条反馈（有效 ${up.length} / 无效 ${down.length}）调整「${profileLabel}」档因子权重，下次该时段扫描自动生效。`,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ ok: false, error: msg }, { status: 500 });
  }
}
