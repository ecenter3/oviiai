import { useState } from 'react';
import { niceTicks } from './LineChart';

export interface BarSeries {
  name: string;
  color: string;
  values: number[];
}

const W = 680;
const L = 44;
const R = 12;
const T = 14;
const B = 26;

/**
 * 白色報表紙面上的長條圖（數據統計）：每天一根，多個數列由下往上堆疊，段與段間留 2 px 白縫；
 * 兩個以上數列一定有圖例；滑過顯示當天各數列數值。
 */
export function BarChart(props: { title: string; unit: string; labels: string[]; series: BarSeries[]; height?: number; max?: number }) {
  const { labels, series } = props;
  const H = props.height ?? 200;
  const iw = W - L - R;
  const ih = H - T - B;
  const [hover, setHover] = useState<number | null>(null);
  const totals = labels.map((_, i) => series.reduce((a, s) => a + (s.values[i] ?? 0), 0));
  const ticks = niceTicks(0, Math.max(props.max ?? 0, ...totals, 1), 4);
  const hi = ticks[ticks.length - 1];
  const Y = (v: number) => T + ih - (v / hi) * ih;
  const slot = iw / Math.max(1, labels.length);
  const bw = Math.max(2, Math.min(28, slot * 0.6));
  const every = Math.ceil(labels.length / 10);
  return (
    <figure className="pchart">
      <figcaption>
        <b>{props.title}</b>
        <span>（{props.unit}）</span>
        {series.length > 1 && (
          <span className="pleg">
            {series.map((s) => (
              <span key={s.name}>
                <i style={{ background: s.color }} />
                {s.name}
              </span>
            ))}
          </span>
        )}
      </figcaption>
      <div className="pchart-box" onPointerLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${props.title}（${props.unit}）`}>
          {ticks.map((v) => (
            <g key={v}>
              <line x1={L} x2={W - R} y1={Y(v)} y2={Y(v)} className="pg-grid" />
              <text x={L - 6} y={Y(v) + 4} className="pg-y">
                {v}
              </text>
            </g>
          ))}
          {labels.map((l, i) => {
            const x = L + slot * i + (slot - bw) / 2;
            let y0 = Y(0);
            return (
              <g key={l} onPointerEnter={() => setHover(i)}>
                <rect x={L + slot * i} y={T} width={slot} height={ih} fill="transparent" />
                {series.map((s) => {
                  const v = s.values[i] ?? 0;
                  if (!v) return null;
                  const h = Math.max(1, (v / hi) * ih);
                  const y = y0 - h;
                  y0 = y;
                  // 段與段之間留 2 px 白縫；最上段圓角 2 px
                  return <rect key={s.name} x={x} y={y} width={bw} height={Math.max(1, h - 2)} rx={1.5} fill={s.color} />;
                })}
                {i % every === 0 && (
                  <text x={x + bw / 2} y={H - 8} className="pg-x">
                    {l}
                  </text>
                )}
              </g>
            );
          })}
          <line x1={L} x2={W - R} y1={Y(0)} y2={Y(0)} className="pg-axis" />
        </svg>
        {hover != null && (
          <div className="pg-tip" style={{ left: `${((L + slot * hover + slot / 2) / W) * 100}%` }} role="status">
            <b>{labels[hover]}</b>
            {series.map((s) => (
              <span key={s.name}>
                <i style={{ background: s.color }} />
                {s.name} {s.values[hover] ?? 0}
              </span>
            ))}
          </div>
        )}
      </div>
    </figure>
  );
}
