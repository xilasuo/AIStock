/**
 * GET /api/kline/<code>             -> 深色标注 K线 SVG（image/svg+xml）
 * GET /api/kline/<code>.json        -> 标注数据 JSON（现价/泡沫顶/突破位/回踩点/生死线 + 原始K线bars）
 * GET /api/kline/<code>.svg         -> 同 <code>（兼容）
 *
 * 周期：?period=day|week|month（默认 day）。JSON 端点的 bars 供前端交互式 K 线图使用。
 *
 * 云端自给自足：服务端直连东财/新浪取日K，本仓库 TS 版标注算法渲染，
 * 不依赖本地 trading_agent 服务。浏览器缓存 30 分钟。
 */
import { fetchKline, fetchName, detectMarkers, renderKlineSvg, type Markers, type KPeriod } from "../../../../lib/kline";

const CACHE_TTL = 60;
const memCache = new Map<string, { ts: number; svg: string; mk: Markers }>();

async function build(code: string, period: KPeriod): Promise<{ svg: string; mk: Markers }> {
  const key = `${code}:${period}`;
  const now = Date.now();
  const hit = memCache.get(key);
  if (hit && now - hit.ts < CACHE_TTL * 1000) return { svg: hit.svg, mk: hit.mk };

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
      "Cache-Control": `public, max-age=${CACHE_TTL}`,
    },
  });
}

export async function GET(req: Request, { params }: { params: Promise<{ code: string }> }) {
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
  try {
    if (isJson) {
      // JSON 端点：直接返回原始 bars 供前端交互式 K 线图渲染，无需拼 SVG。
      const bars = await fetchKline(clean, 320, period);
      if (!bars || bars.length < 30) {
        throw new Error(`K线数据不足或取数失败: ${clean}`);
      }
      const mk = detectMarkers(bars);
      mk.name = (await fetchName(clean)) || clean;
      return Response.json({ ok: true, code: clean, period, markers: mk, bars }, {
        headers: { "Cache-Control": `public, max-age=${CACHE_TTL}` },
      });
    }
    const { svg } = await build(clean, period);
    return sendSvg(svg);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ ok: false, error: `kline render failed: ${msg}` }, { status: 502 });
  }
}
