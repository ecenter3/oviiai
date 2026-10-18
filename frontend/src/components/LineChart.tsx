import { useMemo, useRef, useState } from 'react';
import { t } from '../i18n';

export interface ChartPoint {
  /** 毫秒 */
  t: number;
  v: number | null;
}

const W = 600;
const L = 48;
const R = 16;
const T = 24;
const B = 30;

/** 1-2-5 的整齊刻度 */
export function niceTicks(lo: number, hi: number, n = 5): number[] {
  const span = hi - lo || 1;
  const step0 = span / n;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const f = step0 / mag;
  const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * mag;
  const a = Math.floor(lo / step) * step;
  const b = Math.ceil(hi / step) * step;
  const out: number[] = [];
  for (let v = a; v <= b + step / 2; v += step) out.push(+v.toFixed(6));
  return out;
}

const fmtN = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : String(+v.toFixed(2)));

const hm = new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false });
const hms = new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

/**
 * 單一數列的折線圖（原型 lineChart）：細線＋淡色面積、刻度格線、時間軸，滑過顯示十字線與數值。
 * 兩點間隔超過 gapMs（例：離線）就斷開，不把缺資料畫成直線。
 */
export function LineChart(props: {
  title: string;
  unit: string;
  color: string;
  points: ChartPoint[];
  domain: [number, number];
  yMin?: number;
  yMax?: number;
  gapMs?: number;
  height?: number;
}) {
  const { points, domain, unit, color } = props;
  const H = props.height ?? 230;
  const iw = W - L - R;
  const ih = H - T - B;
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const geo = useMemo(() => {
    const vals = points.filter((p) => p.v != null).map((p) => p.v!) as number[];
    let lo = props.yMin ?? (vals.length ? Math.min(...vals) : 0);
    let hi = props.yMax ?? (vals.length ? Math.max(...vals) : 1);
    if (hi - lo < 1e-6) {
      hi += 1;
      lo -= 1;
    }
    const ticks = niceTicks(lo, hi);
    lo = ticks[0];
    hi = ticks[ticks.length - 1];
    const [t0, t1] = domain;
    const X = (t: number) => L + ((t - t0) / Math.max(1, t1 - t0)) * iw;
    const Y = (v: number) => T + ih - ((v - lo) / (hi - lo)) * ih;
    const base = Y(lo <= 0 && hi >= 0 ? 0 : lo);
    // 依缺值與時間間隔切段
    const segs: ChartPoint[][] = [];
    let cur: ChartPoint[] = [];
    for (const p of points) {
      const prev = cur.at(-1);
      if (p.v == null || (prev && props.gapMs && p.t - prev.t > props.gapMs)) {
        if (cur.length) segs.push(cur);
        cur = p.v == null ? [] : [p];
      } else cur.push(p);
    }
    if (cur.length) segs.push(cur);
    const span = t1 - t0;
    const fmt = span <= 10 * 60_000 ? hms : hm;
    const xTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => ({ x: L + f * iw, label: fmt.format(new Date(t0 + span * f)) }));
    return { ticks, X, Y, base, segs, xTicks, empty: !vals.length };
  }, [points, domain, props.yMin, props.yMax, props.gapMs, iw, ih]);

  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    const svg = svgRef.current;
    if (!svg || !points.length) return;
    const rect = svg.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * W;
    let best = -1;
    let bestD = Infinity;
    points.forEach((p, i) => {
      if (p.v == null) return;
      const d = Math.abs(geo.X(p.t) - x);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    setHover(best >= 0 ? best : null);
  }

  const hp = hover != null ? points[hover] : null;
  const label = `${props.title}（${unit}）`;
  return (
    <div className="ccard">
      <div className="ccard-h">
        {props.title}
        <span>{unit}</span>
      </div>
      <div className="chart-box">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          className="chart"
          role="img"
          aria-label={label}
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
        >
          {geo.ticks.map((v) => (
            <g key={v}>
              <line x1={L} x2={W - R} y1={geo.Y(v)} y2={geo.Y(v)} className="ch-grid" />
              <text x={L - 6} y={geo.Y(v) + 4} className="ch-y">
                {fmtN(v)}
              </text>
            </g>
          ))}
          {geo.xTicks.map((x, i) => (
            <text key={x.x} x={x.x} y={H - 9} className="ch-x" textAnchor={i === 0 ? 'start' : i === geo.xTicks.length - 1 ? 'end' : 'middle'}>
              {x.label}
            </text>
          ))}
          {geo.segs.map((s, i) => {
            const d = s.map((p, j) => `${j ? 'L' : 'M'}${geo.X(p.t).toFixed(1)},${geo.Y(p.v!).toFixed(1)}`).join('');
            const a = s[0];
            const z = s[s.length - 1];
            return (
              <g key={i}>
                <path d={`${d}L${geo.X(z.t).toFixed(1)},${geo.base.toFixed(1)}L${geo.X(a.t).toFixed(1)},${geo.base.toFixed(1)}Z`} fill={color} opacity={0.13} />
                <path d={d} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" />
                {i === geo.segs.length - 1 && <circle cx={geo.X(z.t)} cy={geo.Y(z.v!)} r={3.5} fill={color} />}
              </g>
            );
          })}
          {hp && hp.v != null && (
            <g className="ch-hover">
              <line x1={geo.X(hp.t)} x2={geo.X(hp.t)} y1={T} y2={T + ih} />
              <circle cx={geo.X(hp.t)} cy={geo.Y(hp.v)} r={4.5} fill={color} />
            </g>
          )}
        </svg>
        {hp && hp.v != null && (
          <div className="ch-tip" style={{ left: `${(geo.X(hp.t) / W) * 100}%` }} role="status">
            <b>
              {fmtN(hp.v)} {unit}
            </b>
            <span>{hms.format(new Date(hp.t))}</span>
          </div>
        )}
        {geo.empty && <p className="ch-empty">{t('chart.empty')}</p>}
      </div>
    </div>
  );
}
