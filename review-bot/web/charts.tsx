// Small SVG charts for the operations dashboard. Each renders at its
// container's real pixel width, so text never scales with the plot.

import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";

export type Series = { key: string; label: string; color: string };

export type TipRow = { color?: string; label: string; value: string };

const PAD = { top: 8, right: 8, bottom: 22, left: 44 };

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(([entry]) =>
      setWidth(Math.floor(entry.contentRect.width)),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

/** Up to five round ticks from zero to at least `max`. */
export function niceTicks(max: number): number[] {
  if (!(max > 0)) return [0, 1];
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step =
    [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const ticks = [];
  for (let v = 0; v < max + step * 0.999; v += step) ticks.push(+v.toFixed(6));
  return ticks;
}

/** A rounded-top bar path: 4px radius at the data end, square at the baseline. */
function barPath(x: number, y: number, w: number, h: number, r = 4) {
  if (h <= 0) return "";
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

function Tooltip({
  x,
  width,
  title,
  rows,
}: {
  x: number;
  width: number;
  title: string;
  rows: TipRow[];
}) {
  const right = x > width * 0.6;
  return (
    <div
      class="viz-tip"
      role="status"
      style={right ? { right: `${width - x + 12}px` } : { left: `${x + 12}px` }}
    >
      <strong>{title}</strong>
      {rows.map((r) => (
        <div class="viz-tip-row">
          {r.color && <i style={{ background: r.color }} />}
          <span>{r.label}</span>
          <b>{r.value}</b>
        </div>
      ))}
    </div>
  );
}

export function Legend({ series }: { series: Series[] }) {
  return (
    <ul class="viz-legend">
      {series.map((s) => (
        <li>
          <i style={{ background: s.color }} />
          {s.label}
        </li>
      ))}
    </ul>
  );
}

type TimeProps<T> = {
  points: T[];
  series: Series[];
  value: (p: T, key: string) => number | null;
  t: (p: T) => number;
  fmtT: (t: number) => string;
  fmtTick: (t: number) => string;
  fmtV: (v: number) => string;
  height?: number;
  label: string;
};

/** Shared frame for the time charts: axes, gridlines and a hover band with a tooltip. */
function TimeFrame<T>({
  points,
  series,
  value,
  t,
  fmtT,
  fmtTick,
  fmtV,
  height = 200,
  label,
  max,
  children,
  total,
}: TimeProps<T> & {
  max: number;
  total?: boolean;
  children: (g: {
    x: (i: number) => number;
    band: number;
    y: (v: number) => number;
  }) => ComponentChildren;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const ticks = niceTicks(max);
  const top = ticks.at(-1)!;
  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = height - PAD.top - PAD.bottom;
  const band = points.length ? plotW / points.length : 0;
  const x = (i: number) => PAD.left + i * band;
  const y = (v: number) => PAD.top + plotH - (v / top) * plotH;
  const every = Math.max(1, Math.ceil(points.length / Math.max(1, plotW / 70)));
  const onMove = (e: PointerEvent) => {
    const rect = (e.currentTarget as SVGElement).getBoundingClientRect();
    const i = Math.floor((e.clientX - rect.left - PAD.left) / band);
    setHover(i >= 0 && i < points.length ? i : null);
  };
  const hp = hover === null ? null : points[hover];
  const rows: TipRow[] = hp
    ? series.map((s) => {
        const v = value(hp, s.key);
        return {
          color: s.color,
          label: s.label,
          value: v === null ? "–" : fmtV(v),
        };
      })
    : [];
  if (hp && total)
    rows.push({
      label: "Total",
      value: fmtV(series.reduce((n, s) => n + (value(hp, s.key) ?? 0), 0)),
    });
  return (
    <div class="viz" ref={ref}>
      {width > 0 && (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={label}
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
        >
          {ticks.map((v) => (
            <g>
              <line
                class={v === 0 ? "viz-base" : "viz-grid"}
                x1={PAD.left}
                x2={width - PAD.right}
                y1={y(v)}
                y2={y(v)}
              />
              <text class="viz-tick" x={PAD.left - 6} y={y(v) + 4} text-anchor="end">
                {fmtV(v)}
              </text>
            </g>
          ))}
          {points.map((p, i) =>
            i % every === 0 ? (
              <text
                class="viz-tick"
                x={x(i) + band / 2}
                y={height - 6}
                text-anchor="middle"
              >
                {fmtTick(t(p))}
              </text>
            ) : null,
          )}
          {hover !== null && (
            <rect
              class="viz-hover"
              x={x(hover)}
              y={PAD.top}
              width={band}
              height={plotH}
            />
          )}
          {children({ x, band, y })}
        </svg>
      )}
      {hp && hover !== null && (
        <Tooltip
          x={x(hover) + band / 2}
          width={width}
          title={fmtT(t(hp))}
          rows={rows}
        />
      )}
    </div>
  );
}

/** Stacked columns per time bucket, bottom series first. */
export function TimeBars<T>(props: TimeProps<T>) {
  const { points, series, value } = props;
  const sums = points.map((p) =>
    series.reduce((n, s) => n + (value(p, s.key) ?? 0), 0),
  );
  return (
    <TimeFrame {...props} max={Math.max(0, ...sums)} total={series.length > 1}>
      {({ x, band, y }) => {
        const w = Math.min(24, Math.max(2, band * 0.7));
        return points.map((p, i) => {
          let acc = 0;
          const stack = series
            .map((s) => ({ s, v: value(p, s.key) ?? 0 }))
            .filter((e) => e.v > 0);
          return stack.map(({ s, v }, j) => {
            const y0 = y(acc);
            acc += v;
            const y1 = y(acc);
            const h = Math.max(0, y0 - y1 - (j > 0 ? 2 : 0));
            const bx = x(i) + (band - w) / 2;
            return j === stack.length - 1 ? (
              <path d={barPath(bx, y1, w, h)} fill={s.color} />
            ) : (
              <rect x={bx} y={y1} width={w} height={h} fill={s.color} />
            );
          });
        });
      }}
    </TimeFrame>
  );
}

/** One 2px line per series; gaps where a bucket has no value. */
export function TimeLines<T>(props: TimeProps<T>) {
  const { points, series, value } = props;
  const max = Math.max(
    0,
    ...points.flatMap((p) => series.map((s) => value(p, s.key) ?? 0)),
  );
  return (
    <TimeFrame {...props} max={max}>
      {({ x, band, y }) =>
        series.map((s) => {
          const segs: string[] = [];
          let cur = "";
          const dots: [number, number][] = [];
          points.forEach((p, i) => {
            const v = value(p, s.key);
            if (v === null) {
              if (cur) segs.push(cur);
              cur = "";
              return;
            }
            const px = x(i) + band / 2;
            const py = y(v);
            cur += `${cur ? "L" : "M"}${px},${py}`;
            dots.push([px, py]);
          });
          if (cur) segs.push(cur);
          return (
            <g>
              {segs.map((d) => (
                <path class="viz-line" d={d} stroke={s.color} />
              ))}
              {dots.length <= 40 &&
                dots.map(([cx, cy]) => (
                  <circle class="viz-dot" cx={cx} cy={cy} r={3.5} fill={s.color} />
                ))}
            </g>
          );
        })
      }
    </TimeFrame>
  );
}

export type HBar = {
  label: string;
  value: number;
  /** The part of value drawn in the alert colour, such as errors. */
  part?: number;
  note?: string;
  title?: string;
};

/** Horizontal bars with direct labels; the funnel and tool chart use it. */
export function HBars({
  bars,
  color,
  partColor,
  fmt,
  label,
}: {
  bars: HBar[];
  color: string;
  partColor?: string;
  fmt: (v: number) => string;
  label: string;
}) {
  const max = Math.max(1, ...bars.map((b) => b.value));
  return (
    <ol class="viz-hbars" aria-label={label}>
      {bars.map((b) => {
        const part = Math.min(b.part ?? 0, b.value);
        return (
          <li title={b.title}>
            <span class="viz-hbar-label">{b.label}</span>
            <span class="viz-hbar-track">
              <span
                class="viz-hbar"
                style={{
                  width: `${(b.value / max) * 100}%`,
                  background: color,
                }}
              >
                {part > 0 && (
                  <span
                    class="viz-hbar-part"
                    style={{
                      width: `${(part / b.value) * 100}%`,
                      background: partColor,
                    }}
                  />
                )}
              </span>
            </span>
            <span class="viz-hbar-value">
              {fmt(b.value)}
              {b.note && <small>{b.note}</small>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export type Segment = { label: string; value: number; color: string };

/** One 100% bar split into parts, with a legend that carries the counts. */
export function SegmentBar({
  segments,
  fmt,
  label,
}: {
  segments: Segment[];
  fmt: (v: number) => string;
  label: string;
}) {
  const total = segments.reduce((n, s) => n + s.value, 0);
  const [hover, setHover] = useState<number | null>(null);
  return (
    <div class="viz-seg-wrap">
      <div class="viz-seg" role="img" aria-label={label}>
        {segments.map((s, i) =>
          s.value > 0 ? (
            <span
              class={hover === i ? "on" : undefined}
              style={{ flexGrow: s.value, background: s.color }}
              title={`${s.label}: ${fmt(s.value)} (${pct(s.value, total)})`}
              onPointerEnter={() => setHover(i)}
              onPointerLeave={() => setHover(null)}
            />
          ) : null,
        )}
      </div>
      <ul class="viz-legend viz-legend-values">
        {segments.map((s, i) => (
          <li class={hover === i ? "on" : undefined}>
            <i style={{ background: s.color }} />
            {s.label}
            <b>{fmt(s.value)}</b>
            <small>{pct(s.value, total)}</small>
          </li>
        ))}
      </ul>
    </div>
  );
}

function pct(v: number, total: number) {
  return total > 0 ? `${Math.round((v / total) * 100)}%` : "–";
}

/** A tiny trend line for a stat tile; no axes, no hover. */
export function Sparkline({ values }: { values: number[] }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const h = 32;
  const max = Math.max(...values, 0);
  const d =
    values.length > 1 && width > 0
      ? values
          .map((v, i) => {
            const px = (i / (values.length - 1)) * (width - 4) + 2;
            const py = h - 3 - (max > 0 ? (v / max) * (h - 6) : 0);
            return `${i ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`;
          })
          .join("")
      : "";
  return (
    <div class="viz-spark" ref={ref} aria-hidden="true">
      {d && (
        <svg width={width} height={h}>
          <path d={`${d}L${width - 2},${h}L2,${h}Z`} class="viz-spark-area" />
          <path d={d} class="viz-spark-line" />
        </svg>
      )}
    </div>
  );
}

/** Rerenders on an interval, for relative times. */
export function useNow(ms: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}
