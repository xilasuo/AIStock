/**
 * GET /api/kline/<code>             -> 深色标注 K线 SVG（image/svg+xml）
 * GET /api/kline/<code>.json        -> 标注数据 JSON（现价/泡沫顶/突破位/回踩点/生死线 + 原始K线bars）
 * GET /api/kline/<code>.svg         -> 同 <code>（兼容）
 *
 * 周期：?period=day|week|month（默认 day）。JSON 端点的 bars 供前端交互式 K 线图使用。
 *
 * 云端自给自足：服务端直连东财/新浪取日K，本仓库 TS 版标注算法渲染，
 * 不依赖本地 trading_agent 服务。
 *
 * 鉴权：需登录会话（Cookie）或推送令牌。本接口会回源东财/新浪，若开放匿名访问
 * 等同于把上游行情接口当免费代理，且内存缓存易被打满（缓存投毒 / OOM），故必须鉴权。
 * 因响应含用户态校验，缓存头一律为 private，禁止 CDN / 共享缓存留存。
 */
import { requireApiUserOrPushToken, getAuthenticatedUser } from "../../../../lib/auth/auth";
import { fetchKline, fetchName, detectMarkers, renderKlineSvg, type Markers, type KPeriod } from "../../../../lib/kline";

const CACHE_TTL = 60;
const memCache = new Map<string, { ts: number; svg: string; mk: Markers }>();

/**
 * 单用户回源限流：限制「缓存未命中」的上游请求频率。
 * 命中内存缓存的请求不计数，因其不产生上游流量。
 */
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_MISSES = 30;
const rateBuckets = new Map<string, { windowStart: number; count: number }>();

function takeRateToken(key: string): boolean {
  const now = Date.now();
  const bucket = rateBuckets.get(key);
  if (!bucket || now - bucket.windowStart >= RATE_LIMIT_WINDOW_MS) {
    rateBuckets.set(key, { windowStart: now, count: 1 });
    // 顺带清理过期桶，避免 Map 无限增长
    if (rateBuckets.size > 500) {
      for (const [k, v] of rateBuckets) {
        if (now - v.windowStart >= RATE_LIMIT_WINDOW_MS) rateBuckets.delete(k);
      }
    }
    return true;
  }
  if (bucket.count >= RATE_LIMIT_MAX_MISSES) return false;
  bucket.count += 1;
  return true;
}

function peekCache(code: string, period: KPeriod): { svg: string; mk: Markers } | null {
  const hit = memCache.get(`${code}:${period}`);
  if (hit && Date.now() - hit.ts < CACHE_TTL * 1000) return { svg: hit.svg, mk: hit.mk };
  return null;
}

async function build(code: string, period: KPeriod): Promise<{ svg: string; mk: Markers }> {
  const key = `${code}:${period}`;
  const now = Date.now();
  const hit = peekCache(code, period);
  if (hit) return hit;

  const bars = await fetchKline(code, 220, period);
  if (!bars || bars.length < 30) {
    throw new Error(`K线数据不足或取数失败: ${code}`);
  }
  const mk = detectMarkers(bars);
  mk.name = (await fetchName(code)) || code;
  const svg = renderKlineSvg(code, mk.name, bars, mk, 110);

  memCache.set(key, { ts: now, svg, mk });
  if (memCache.size > 400) {
    const oldest = [...memCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0]?.[0];
    if (oldest) memCache.delete(oldest);
  }
  return { svg, mk };
}

function sendSvg(svg: string): Response {
  return new Response(svg, {
    status: 200,
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      // private：响应经过用户鉴权，不得被 CDN / 代理等共享缓存留存
      "Cache-Control": `private, max-age=${CACHE_TTL}`,
    },
  });
}

export async function GET(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const unauthorized = await requireApiUserOrPushToken(req);
  if (unauthorized) return unauthorized;

  const { code } = await params;
  const raw = (code || "").trim();
  const isJson = raw.endsWith(".json");
  const clean = raw.replace(/\.(svg|json)$/i, "");
  if (!clean || !/^[0-9]{6}$/.test(clean)) {
    return Response.json({ ok: false, error: "invalid code, use /api/kline/<6位代码>" }, { status: 400 });
  }
  const url = new URL(req.url);
  const periodParam = url.searchParams.get("period");
  const period: KPeriod =
    periodParam === "week" ? "week" : periodParam === "month" ? "month" : "day";

  // 限流键：优先按用户隔离，令牌调用方（无会话）归入共享桶。
  const viewer = await getAuthenticatedUser();
  const rateKey = viewer ? `u:${viewer.id}` : "token";

  try {
    if (isJson) {
      // JSON 端点：直接返回原始 bars 供前端交互式 K 线图渲染，无需拼 SVG。
      // 无本地缓存，每次都会回源，故一律计入限流。
      if (!takeRateToken(rateKey)) {
        return Response.json(
          { ok: false, error: "K线请求过于频繁，请稍后再试" },
          { status: 429, headers: { "Retry-After": "60" } },
        );
      }
      const bars = await fetchKline(clean, 320, period);
      if (!bars || bars.length < 30) {
        throw new Error(`K线数据不足或取数失败: ${clean}`);
      }
      const mk = detectMarkers(bars);
      mk.name = (await fetchName(clean)) || clean;
      return Response.json({ ok: true, code: clean, period, markers: mk, bars }, {
        headers: { "Cache-Control": `private, max-age=${CACHE_TTL}` },
      });
    }
    // SVG 端点：命中内存缓存不产生上游流量，直接返回，不计入限流。
    const cached = peekCache(clean, period);
    if (cached) return sendSvg(cached.svg);
    if (!takeRateToken(rateKey)) {
      return Response.json(
        { ok: false, error: "K线请求过于频繁，请稍后再试" },
        { status: 429, headers: { "Retry-After": "60" } },
      );
    }
    const { svg } = await build(clean, period);
    return sendSvg(svg);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ ok: false, error: `kline render failed: ${msg}` }, { status: 502 });
  }
}
