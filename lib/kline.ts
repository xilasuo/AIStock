/**
 * K线技术面板 · 云端自给自足版（TypeScript 移植）
 *
 * 与 trading_agent/render_kline.py 同一套逻辑：
 *   - 双源取数：东财 push2his（前复权）→ 新浪（未复权兜底），服务端直连无 CORS 问题
 *   - 五条关键价位标注：泡沫顶 / 突破确认位 / 现价 / 回踩点 / 双底（生死线）
 *   - 深色 SVG 渲染：红涨绿跌蜡烛 + 成交量柱（A股惯例）
 *
 * 由 app/api/kline/[code]/route.ts 调用；前端 <img src="/api/kline/600367.svg"> 直接展示。
 */

export type KBar = {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  vol: number;
};

export type Markers = {
  name: string;
  priceNow: number;
  ma5: number;
  ma10: number;
  ma20: number;
  ma60: number;
  ma120: number;
  maPos: string;
  top: { price: number; date: string; isTrap: boolean };
  breakout: number;
  retest: { price: number; date: string } | null;
  support: number;
  doubleBottom: { support: number; neck: number; dates: [string, string] } | null;
};

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/117.0.0.0 Safari/537.36";

/* ------------------------- 取数：东财 -> 新浪 双源 ------------------------- */

function emSecid(code: string): string {
  if (code.startsWith("880") || code.startsWith("999")) return "1.";
  if (code.startsWith("399")) return "0.";
  const pureIndex = new Set([
    "000016", "000300", "000688", "000905", "000010", "000009", "000013",
  ]);
  if (pureIndex.has(code)) return "1.";
  return code.startsWith("6") ? "1." : "0.";
}

function sinaPrefix(code: string): string {
  if (code.startsWith("6") || code.startsWith("9")) return "sh";
  if (code.startsWith("8")) return "bj";
  return "sz";
}

/** K线周期：day=日K week=周K month=月K（东财 klt 编码）。 */
export type KPeriod = "day" | "week" | "month";
const KLT: Record<KPeriod, number> = { day: 101, week: 102, month: 103 };

export async function fetchKline(code: string, limit = 220, period: KPeriod = "day"): Promise<KBar[]> {
  try {
    const url =
      `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${emSecid(code)}${code}` +
      `&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56` +
      `&klt=${KLT[period]}&fqt=1&end=20500101&lmt=${limit}`;
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Referer: "https://quote.eastmoney.com/" },
      signal: AbortSignal.timeout(8000),
    });
    const j = (await res.json()) as { data?: { klines?: string[] } };
    const kls = j.data?.klines;
    if (kls && kls.length) {
      return kls.map((line) => {
        const p = line.split(",");
        return {
          date: p[0],
          open: Number(p[1]),
          close: Number(p[2]),
          high: Number(p[3]),
          low: Number(p[4]),
          vol: Number(p[5]),
        };
      });
    }
  } catch {
    /* 东财失败 -> 新浪兜底 */
  }
  const url =
    `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/` +
    `CN_MarketData.getKLineData?symbol=${sinaPrefix(code)}${code}&scale=240&ma=no&datalen=${limit}`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Referer: "https://finance.sina.com.cn/" },
    signal: AbortSignal.timeout(8000),
  });
  const raw = (await res.json()) as Array<{
    day: string; open: string; high: string; low: string; close: string; volume: string;
  }>;
  return (raw || []).map((b) => ({
    date: b.day,
    open: Number(b.open),
    close: Number(b.close),
    high: Number(b.high),
    low: Number(b.low),
    vol: Number(b.volume),
  }));
}

export async function fetchName(code: string): Promise<string> {
  try {
    const url = `https://push2.eastmoney.com/api/qt/stock/get?secid=${emSecid(code)}${code}&fields=f57,f58`;
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Referer: "https://quote.eastmoney.com/" },
      signal: AbortSignal.timeout(6000),
    });
    const j = (await res.json()) as { data?: { f58?: string } };
    if (j.data?.f58) return j.data.f58;
  } catch {
    /* 取不到名称则回退 code */
  }
  return code;
}

/* ----------------------------- 标注识别 ----------------------------- */

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function recentResistance(highs: number[], price: number, n: number, look = 8): number | null {
  for (let i = n - 1; i >= 0; i--) {
    const h = highs[i];
    if (h < price * 1.03) continue;
    let maxAfter = -Infinity;
    for (let k = i + 1; k < Math.min(n, i + 1 + look); k++) {
      if (highs[k] > maxAfter) maxAfter = highs[k];
    }
    if (maxAfter < h) return h;
  }
  return null;
}

export function detectMarkers(bars: KBar[], name = ""): Markers {
  const n = bars.length;
  const closes = bars.map((b) => b.close);
  const highs = bars.map((b) => b.high);
  const lows = bars.map((b) => b.low);
  const dates = bars.map((b) => b.date);

  const ma5 = mean(closes.slice(-5)) || mean(closes);
  const ma10 = mean(closes.slice(-10)) || mean(closes);
  const ma20 = mean(closes.slice(-20)) || mean(closes);
  const ma60 = mean(closes.slice(-60)) || mean(closes);
  const ma120 = mean(closes.slice(-120)) || mean(closes);
  const priceNow = closes[n - 1];

  // 泡沫顶：近 120 根最高
  const win = Math.min(n, 120);
  const topWin = highs.slice(-win);
  let topLocal = 0;
  for (let i = 1; i < topWin.length; i++) if (topWin[i] > topWin[topLocal]) topLocal = i;
  const topPrice = topWin[topLocal];
  const topDate = dates[n - win + topLocal];
  const isTrap = topLocal <= win - 1 - 20;

  // 双底识别：局部低点配对（间隔>=20、价差<=5%、中间反弹>=10%）
  const W = 6;
  const lowsIdx: number[] = [];
  for (let i = W; i < n - W; i++) {
    let isMin = true;
    for (let k = i - W; k <= i + W; k++) if (lows[k] < lows[i]) { isMin = false; break; }
    if (isMin && lows[i] < lows[i - 1]) lowsIdx.push(i);
  }
  let doubleBottom: Markers["doubleBottom"] = null;
  for (let j = lowsIdx.length - 1; j >= 1; j--) {
    const iA = lowsIdx[j - 1];
    const iB = lowsIdx[j];
    if (iB - iA < 20) continue;
    const pA = lows[iA];
    const pB = lows[iB];
    if (pA <= 0 || Math.abs(pB - pA) / pA > 0.05) continue;
    let midHigh = -Infinity;
    for (let k = iA; k <= iB; k++) if (highs[k] > midHigh) midHigh = highs[k];
    if (midHigh > Math.max(pA, pB) * 1.1) {
      doubleBottom = {
        support: Math.min(pA, pB),
        neck: midHigh,
        dates: [dates[iA], dates[iB]],
      };
      break;
    }
  }

  // 生死线 / 突破确认位
  let support: number;
  let breakout: number;
  if (doubleBottom) {
    support = doubleBottom.support;
    breakout = doubleBottom.neck;
  } else {
    support = Math.min(...lows.slice(-Math.min(n, 30)));
    const res = recentResistance(highs, priceNow, n);
    breakout = res === null ? Math.max(...closes.slice(-Math.min(n, 60))) : res;
  }

  // 回踩点
  let retest: Markers["retest"] = null;
  if (doubleBottom) {
    const above: number[] = [];
    for (let i = 0; i < n; i++) if (closes[i] > breakout) above.push(i);
    if (above.length) {
      let best: { i: number; l: number } | null = null;
      for (let i = above[0]; i < n; i++) {
        if (lows[i] >= breakout * 0.92 && lows[i] <= breakout * 1.06) {
          if (!best || lows[i] < best.l) best = { i, l: lows[i] };
        }
      }
      if (best && n - 1 - best.i >= 2) retest = { price: best.l, date: dates[best.i] };
    }
  } else {
    let best: { i: number; l: number } | null = null;
    for (let i = Math.max(0, n - 20); i < n - 3; i++) {
      if (lows[i] < priceNow && lows[i] >= support * 0.98) {
        if (!best || lows[i] > best.l) best = { i, l: lows[i] };
      }
    }
    if (best) retest = { price: best.l, date: dates[best.i] };
  }

  // 现价相对均线位置
  let maPos: string;
  if (priceNow > ma20 && priceNow > ma120) maPos = "站稳 MA20/MA120";
  else if (priceNow > ma20 || priceNow > ma120) maPos = "顶在 MA20/MA120";
  else maPos = "位于 MA20/MA120 下方";

  return {
    name,
    priceNow,
    ma5,
    ma10,
    ma20,
    ma60,
    ma120,
    maPos,
    top: { price: topPrice, date: topDate, isTrap },
    breakout,
    retest,
    support,
    doubleBottom,
  };
}

/* ----------------------------- SVG 渲染 ----------------------------- */

const C_BG = "#0a0e14";
const C_GRID = "#1f2937";
const C_UP = "#ef4444";
const C_DOWN = "#22c55e";
const C_TEXT = "#e2e8f0";
const C_SUB = "#94a3b8";
const C_DIM = "#64748b";
const C_BLUE = "#3b82f6";
const C_ORANGE = "#f59e0b";
const C_GRAY = "#9ca3af";
const C_MA5 = "#e2e8f0"; // 白
const C_MA10 = "#facc15"; // 黄
const C_MA20 = "#c084fc"; // 紫
const C_MA60 = "#4ade80"; // 绿（A股软件惯例）
const FONT = "ui-monospace, Menlo, Consolas, monospace";

/** 滚动均线：返回每根K线对应的 MA 值，窗口未满时为 null */
function calcMA(closes: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  let sum = 0;
  for (let i = 0; i < closes.length; i++) {
    sum += closes[i];
    if (i >= period) sum -= closes[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function maPolyline(cx: number[], ma: (number | null)[], Y: (p: number) => number, color: string): string {
  const pts: string[] = [];
  for (let i = 0; i < ma.length; i++) {
    const v = ma[i];
    if (v === null) continue;
    pts.push(`${cx[i].toFixed(1)},${Y(v).toFixed(1)}`);
  }
  if (!pts.length) return "";
  return `<polyline points="${pts.join(" ")}" fill="none" stroke="${color}" stroke-width="1.1" opacity="0.9"/>`;
}

export function renderKlineSvg(code: string, name: string, bars: KBar[], mk: Markers, maxBars = 110): string {
  const show = bars.slice(-maxBars);
  const n = show.length;
  const dates = show.map((b) => b.date);
  const opens = show.map((b) => b.open);
  const closes = show.map((b) => b.close);
  const highs = show.map((b) => b.high);
  const lows = show.map((b) => b.low);
  const vols = show.map((b) => b.vol);

  const pMin = Math.min(...lows);
  const pMax = Math.max(...highs);
  const pad = (pMax - pMin) * 0.08 || 1;
  const lo = pMin - pad;
  const hi = pMax + pad;
  const Y = (p: number) => 18 + ((hi - p) / (hi - lo)) * 360;

  const vMax = Math.max(...vols) || 1;
  const YV = (v: number) => 446 - (v / vMax) * 64;

  const areaX0 = 24;
  const areaX1 = 636;
  const areaW = areaX1 - areaX0;
  const slot = areaW / n;
  const cw = Math.max(3, Math.min(10, slot * 0.62));
  const left = Array.from({ length: n }, (_, i) => areaX0 + i * slot + (slot - cw) / 2);
  const cx = Array.from({ length: n }, (_, i) => areaX0 + i * slot + slot / 2);

  const dShort = (d: string) => (d.length >= 10 ? d.slice(5) : d);

  const top =
    `<g font-size="9" fill="${C_SUB}">` +
    `<rect x="24" y="2" width="8" height="8" fill="${C_UP}"/><text x="36" y="9">涨</text>` +
    `<rect x="52" y="2" width="8" height="8" fill="${C_DOWN}"/><text x="64" y="9">跌</text>` +
    `<text x="84" y="9" fill="${C_TEXT}">${name} ${code} · 日K ${dShort(dates[0])}~${dShort(dates[n - 1])}</text>` +
    `<text x="360" y="9" fill="${C_ORANGE}">${mk.support.toFixed(3)} 双底（生死线）</text>` +
    `<text x="636" y="9" text-anchor="end" fill="${C_DIM}">截至 ${dShort(dates[n - 1])} 收盘</text></g>`;

  const grid: string[] = [];
  const scale: string[] = [];
  for (let k = 0; k < 5; k++) {
    const v = hi - (k * (hi - lo)) / 4;
    const y = Y(v);
    grid.push(
      `<line x1="${areaX0}" y1="${y.toFixed(1)}" x2="${areaX1}" y2="${y.toFixed(1)}" stroke="${C_GRID}" stroke-dasharray="2,3" stroke-width="0.5"/>`,
    );
    scale.push(`<text x="20" y="${(y + 3).toFixed(1)}" text-anchor="end" font-size="9" fill="${C_DIM}">${v.toFixed(3)}</text>`);
  }

  const lines: string[] = [];
  const tags: string[] = [];
  const t = mk.top;
  lines.push(
    `<line x1="${areaX0}" y1="${Y(t.price).toFixed(1)}" x2="${areaX1}" y2="${Y(t.price).toFixed(1)}" stroke="${C_UP}" stroke-width="0.6" stroke-dasharray="6,4" opacity="0.55"/>`,
  );
  tags.push(
    `<text x="632" y="${(Y(t.price) - 4).toFixed(1)}" text-anchor="end" font-size="9" fill="${C_TEXT}">${t.price.toFixed(3)} 泡沫顶 · ${dShort(t.date)}${t.isTrap ? "（上方套牢盘）" : ""}</text>`,
  );
  lines.push(
    `<line x1="${areaX0}" y1="${Y(mk.breakout).toFixed(1)}" x2="${areaX1}" y2="${Y(mk.breakout).toFixed(1)}" stroke="${C_GRAY}" stroke-width="0.5" stroke-dasharray="3,3" opacity="0.55"/>`,
  );
  tags.push(
    `<text x="632" y="${(Y(mk.breakout) - 4).toFixed(1)}" text-anchor="end" font-size="9" fill="${C_SUB}">${mk.breakout.toFixed(3)} 突破确认位</text>`,
  );
  lines.push(
    `<line x1="${areaX0}" y1="${Y(mk.priceNow).toFixed(1)}" x2="${areaX1}" y2="${Y(mk.priceNow).toFixed(1)}" stroke="${C_BLUE}" stroke-width="1.2"/>`,
  );
  tags.push(
    `<text x="632" y="${(Y(mk.priceNow) + 12).toFixed(1)}" text-anchor="end" font-size="9" fill="${C_BLUE}" font-weight="500">${mk.priceNow.toFixed(3)} 现价（${mk.maPos}）</text>`,
  );
  if (mk.retest) {
    lines.push(
      `<line x1="${areaX0}" y1="${Y(mk.retest.price).toFixed(1)}" x2="${areaX1}" y2="${Y(mk.retest.price).toFixed(1)}" stroke="${C_GRAY}" stroke-width="0.5" stroke-dasharray="3,3" opacity="0.55"/>`,
    );
    tags.push(
      `<text x="632" y="${(Y(mk.retest.price) - 4).toFixed(1)}" text-anchor="end" font-size="9" fill="${C_SUB}">${mk.retest.price.toFixed(3)} 回踩点</text>`,
    );
  }
  lines.push(
    `<line x1="${areaX0}" y1="${Y(mk.support).toFixed(1)}" x2="${areaX1}" y2="${Y(mk.support).toFixed(1)}" stroke="${C_ORANGE}" stroke-width="0.9" stroke-dasharray="4,3"/>`,
  );
  tags.push(
    `<text x="632" y="${(Y(mk.support) + 12).toFixed(1)}" text-anchor="end" font-size="9" fill="${C_ORANGE}" font-weight="500">${mk.support.toFixed(3)} 双底（生死线）</text>`,
  );

  const candles: string[] = [];
  for (let i = 0; i < n; i++) {
    const color = closes[i] >= opens[i] ? C_UP : C_DOWN;
    const hgt = Math.max(1, Math.abs(Y(opens[i]) - Y(closes[i])));
    candles.push(
      `<line x1="${cx[i].toFixed(1)}" y1="${Y(highs[i]).toFixed(1)}" x2="${cx[i].toFixed(1)}" y2="${Y(lows[i]).toFixed(1)}" stroke="${color}"/>` +
        `<rect x="${left[i].toFixed(1)}" y="${Y(Math.max(opens[i], closes[i])).toFixed(1)}" width="${cw.toFixed(1)}" height="${hgt.toFixed(1)}" fill="${color}"/>`,
    );
  }

  const vbars: string[] = [];
  for (let i = 0; i < n; i++) {
    const color = closes[i] >= opens[i] ? C_UP : C_DOWN;
    vbars.push(
      `<rect x="${left[i].toFixed(1)}" y="${YV(vols[i]).toFixed(1)}" width="${cw.toFixed(1)}" height="${(446 - YV(vols[i])).toFixed(1)}" fill="${color}" opacity="0.85"/>`,
    );
  }

  const tlabels: string[] = [];
  for (const idx of [0, Math.floor(n / 3), Math.floor((2 * n) / 3), n - 1]) {
    tlabels.push(
      `<text x="${cx[idx].toFixed(1)}" y="462" text-anchor="middle" font-size="9" fill="${C_DIM}">${dShort(dates[idx])}</text>`,
    );
  }

  // ---- MA5/10/20/60 均线曲线（画在蜡烛之上） ----
  const mas = [
    { period: 5, color: C_MA5, label: "MA5" },
    { period: 10, color: C_MA10, label: "MA10" },
    { period: 20, color: C_MA20, label: "MA20" },
    { period: 60, color: C_MA60, label: "MA60" },
  ].map((m) => ({ ...m, arr: calcMA(closes, m.period) }));
  const maLines = mas.map((m) => maPolyline(cx, m.arr, Y, m.color)).join("");
  const maLegend =
    `<g font-size="8.5">` +
    `<rect x="28" y="22" width="178" height="26" rx="3" fill="rgba(10,14,20,0.62)" stroke="${C_GRID}" stroke-width="0.5"/>` +
    mas.map((m, idx) => {
      const col = idx % 2;
      const row = Math.floor(idx / 2);
      const v = m.arr[n - 1];
      const txt = v === null ? "--" : v.toFixed(3);
      const lx = 34 + col * 70;
      const ly = 27 + row * 12;
      return (
        `<rect x="${lx}" y="${ly}" width="7" height="7" fill="${m.color}"/>` +
        `<text x="${lx + 10}" y="${ly + 7}" fill="${m.color}">${m.label} ${txt}</text>`
      );
    }).join("") +
    `</g>`;

  return (
    `<svg viewBox="0 0 680 480" xmlns="http://www.w3.org/2000/svg" role="img" font-family="${FONT}">` +
    `<title>${name} ${code} 日K 技术面板</title>` +
    `<desc>${name} ${code} 日K线，MA5/10/20/60 均线，标注泡沫顶、突破确认位、现价、回踩点、双底（生死线）。</desc>` +
    `<defs><pattern id="g" width="20" height="20" patternUnits="userSpaceOnUse">` +
    `<path d="M 20 0 L 0 0 0 20" fill="none" stroke="${C_GRID}" stroke-width="0.5"/></pattern>` +
    `<pattern id="g2" width="20" height="14" patternUnits="userSpaceOnUse">` +
    `<path d="M 20 0 L 0 0 0 14" fill="none" stroke="${C_GRID}" stroke-width="0.5"/></pattern></defs>` +
    top +
    `<rect x="${areaX0}" y="18" width="${areaW}" height="360" fill="${C_BG}"/>` +
    `<rect x="${areaX0}" y="18" width="${areaW}" height="360" fill="url(#g)"/>` +
    grid.join("") + scale.join("") + lines.join("") +
    `<g stroke-width="1">${candles.join("")}</g>` +
    maLines +
    maLegend +
    tags.join("") +
    `<line x1="${areaX0}" y1="380" x2="${areaX1}" y2="380" stroke="${C_GRID}" stroke-width="0.5"/>` +
    `<rect x="${areaX0}" y="382" width="${areaW}" height="64" fill="${C_BG}"/>` +
    `<rect x="${areaX0}" y="382" width="${areaW}" height="64" fill="url(#g2)"/>` +
    vbars.join("") +
    `<text x="24" y="472" font-size="9" fill="${C_DIM}">成交量</text>` +
    tlabels.join("") +
    `</svg>`
  );
}
