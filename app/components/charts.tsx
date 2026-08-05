"use client";

/** 占比环图（DonutChart）与排行条形图（BarList）用纯 SVG 实现，零依赖、在
 * Cloudflare 边缘环境稳定渲染。
 *
 * 资金权益曲线已迁移到 lightweight-charts（见 equity-chart.tsx），以获得
 * 专业金融图表的缩放/十字光标交互体验。
 */

function formatCents(cents: number): string {
  const value = cents / 100;
  const sign = value < 0 ? "-" : "";
  return `${sign}¥${Math.abs(value).toLocaleString("zh-CN", { maximumFractionDigits: 0 })}`;
}

export function BarList({
  items,
  format = (value) => formatCents(value),
}: {
  items: Array<{ label: string; value: number; sub?: string }>;
  format?: (value: number) => string;
}) {
  if (!items.length) return <p className="chart-empty">暂无数据。</p>;
  const maxAbs = Math.max(...items.map((item) => Math.abs(item.value)), 1);
  return (
    <ul className="bar-list">
      {items.map((item) => {
        const widthPercent = (Math.abs(item.value) / maxAbs) * 100;
        const tone = item.value > 0 ? "bar--profit" : item.value < 0 ? "bar--loss" : "bar--flat";
        return (
          <li key={item.label} className="bar-row">
            <span className="bar-label" title={item.label}>{item.label}</span>
            <span className="bar-track">
              <span className={`bar-fill ${tone}`} style={{ width: `${widthPercent}%` }} />
            </span>
            <span className="bar-value">{format(item.value)}{item.sub ? <small> {item.sub}</small> : null}</span>
          </li>
        );
      })}
    </ul>
  );
}

const DONUT_PALETTE = [
  "var(--accent)",   // 青蓝（主色）
  "var(--amber)",    // 琥珀
  "#5cc8ff",         // 亮青蓝
  "#ffc24d",         // 金
  "#34d399",         // 绿
  "#ff8a7a",         // 珊瑚红
  "#b98cff",         // 紫
  "#ffd98a",         // 沙
  "#7fb0e6",         // 钢蓝
  "#d6e06b",         // 黄绿
];

export function DonutChart({
  segments,
  size = 180,
}: {
  segments: Array<{ label: string; value: number }>;
  size?: number;
}) {
  const total = segments.reduce((sum, segment) => sum + Math.max(0, segment.value), 0);
  if (total <= 0) return <p className="chart-empty">暂无持仓占比数据。</p>;
  const radius = size / 2 - 12;
  const innerRadius = radius * 0.58;
  const center = size / 2;
  const fractions = segments.map((s) => Math.max(0, s.value) / total);
  const startAngles = fractions.reduce<number[]>((acc, f, i) => {
    const base = i === 0 ? -Math.PI / 2 : acc[i - 1] + fractions[i - 1] * Math.PI * 2;
    acc.push(base);
    return acc;
  }, []);
  const arcs = segments.map((segment, index) => {
    const fraction = fractions[index];
    const start = startAngles[index];
    const end = start + fraction * Math.PI * 2;
    const largeArc = fraction > 0.5 ? 1 : 0;
    const x1 = center + radius * Math.cos(start);
    const y1 = center + radius * Math.sin(start);
    const x2 = center + radius * Math.cos(end);
    const y2 = center + radius * Math.sin(end);
    const ix2 = center + innerRadius * Math.cos(end);
    const iy2 = center + innerRadius * Math.sin(end);
    const ix1 = center + innerRadius * Math.cos(start);
    const iy1 = center + innerRadius * Math.sin(start);
    const path = `M${x1.toFixed(2)},${y1.toFixed(2)} A${radius},${radius} 0 ${largeArc} 1 ${x2.toFixed(2)},${y2.toFixed(2)} L${ix2.toFixed(2)},${iy2.toFixed(2)} A${innerRadius},${innerRadius} 0 ${largeArc} 0 ${ix1.toFixed(2)},${iy1.toFixed(2)} Z`;
    return { path, label: segment.label, color: DONUT_PALETTE[index % DONUT_PALETTE.length], percent: fraction * 100 };
  });
  return (
    <div className="donut-wrap">
      <svg className="donut-chart" viewBox={`0 0 ${size} ${size}`} role="img" aria-label="持仓占比">
        {arcs.map((arc) => (
          <path key={arc.label} d={arc.path} fill={arc.color} className="donut-segment" />
        ))}
        <text x={center} y={center - 4} className="donut-center" textAnchor="middle">{segments.length}</text>
        <text x={center} y={center + 14} className="donut-center-sub" textAnchor="middle">只持仓</text>
      </svg>
      <ul className="donut-legend">
        {arcs.map((arc) => (
          <li key={arc.label}>
            <span className="donut-dot" style={{ background: arc.color }} />
            <span className="donut-legend-label" title={arc.label}>{arc.label}</span>
            <span className="donut-legend-percent">{arc.percent.toFixed(1)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Sparkline 迷你走势图：把最近 N 根 K 线画成一条平滑曲线，中间渲染一个
 * 圆点强调当前价格；用箭头色（红涨绿跌）提示方向，不依赖颜色亦可读懂。
 */
export function Sparkline({ history, baseClose, change, width = 220, height = 56 }: {
  history: Array<{ date: string; close: number }>;
  baseClose: number | null;
  change: number | null;
  width?: number;
  height?: number;
}) {
  const rows = history.slice(-30);
  if (rows.length < 2) {
    return <div className="sparkline sparkline--empty" aria-hidden="true" />;
  }
  const closes = rows.map((row) => row.close);
  const min = Math.min(...closes, baseClose ?? Infinity);
  const max = Math.max(...closes, baseClose ?? -Infinity);
  const range = Math.max(max - min, 0.0001);
  const step = rows.length > 1 ? width / (rows.length - 1) : width;
  const pad = 4;
  const usableH = height - pad * 2;
  const x = (index: number) => index * step;
  const y = (value: number) => pad + (max - value) / range * usableH;
  const points = rows.map((row, index) => `${x(index).toFixed(1)},${y(row.close).toFixed(1)}`).join(" ");
  const lastX = x(rows.length - 1);
  const lastY = y(rows[rows.length - 1].close);
  const direction = change === null ? "flat" : change >= 0 ? "up" : "down";
  const baseY = baseClose === null ? null : y(baseClose);
  return (
    <svg
      className={`sparkline sparkline--${direction}`}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={change === null ? "价格走势" : `加入关注以来${change >= 0 ? "上涨" : "下跌"}${Math.abs(change).toFixed(2)}%`}
    >
      {baseY !== null && (
        <line x1="0" x2={width} y1={baseY} y2={baseY} className="sparkline__base" />
      )}
      <polyline points={points} className="sparkline__line" />
      <circle cx={lastX} cy={lastY} r="3" className="sparkline__dot" />
    </svg>
  );
}
