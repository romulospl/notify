"use client";

import { useState } from "react";
import { AxisLabels } from "./axis-labels";
import { ChartTooltip, tooltipSide } from "./chart-tooltip";
import { PALETTE } from "./palette";
import { niceSeconds, ticksFor } from "./scale";
import { useRovingFocus } from "./use-roving-focus";

export type BandPoint = { label: string; longLabel: string; low: number | null; high: number | null; description: string };

type LineBandChartProps = {
  points: BandPoint[];
  label: string;
  names: { low: string; high: string; lowShort: string; highShort: string };
  format: (value: number | null) => string;
  tick: (value: number) => string;
  emptyTooltip: string;
};

type Coordinate = { x: number; y: number };

function segments(values: (number | null)[], top: number): Coordinate[][] {
  const out: Coordinate[][] = [];
  let cur: Coordinate[] = [];
  values.forEach((v, i) => {
    if (v === null) {
      if (cur.length) out.push(cur);
      cur = [];
    } else cur.push({ x: i + 0.5, y: 100 - (Math.min(v, top) / top) * 100 });
  });
  if (cur.length) out.push(cur);
  return out;
}

function bands(low: (number | null)[], high: (number | null)[], top: number): string[] {
  const out: string[] = [];
  let upper: Coordinate[] = [];
  let lower: Coordinate[] = [];
  const flush = () => {
    if (upper.length > 1) out.push([...upper, ...lower.reverse()].map((p) => `${p.x},${p.y}`).join(" "));
    upper = [];
    lower = [];
  };
  low.forEach((l, i) => {
    const h = high[i];
    if (l === null || h === null || h === undefined) return flush();
    upper.push({ x: i + 0.5, y: 100 - (Math.min(h, top) / top) * 100 });
    lower.push({ x: i + 0.5, y: 100 - (Math.min(l, top) / top) * 100 });
  });
  flush();
  return out;
}

function lastValue(values: (number | null)[]): number | null {
  for (let i = values.length - 1; i >= 0; i--) if (values[i] !== null) return values[i]!;
  return null;
}

export function LineBandChart({ points, label, names, format, tick, emptyTooltip }: LineBandChartProps) {
  const [active, setActive] = useState<number | null>(null);
  const n = points.length;
  const low = points.map((p) => p.low);
  const high = points.map((p) => p.high);
  const { top, step } = niceSeconds(Math.max(0, ...high.map((v) => v ?? 0), ...low.map((v) => v ?? 0)));
  const ticks = ticksFor(top, step);
  const hovered = active === null ? null : points[active];
  const roving = useRovingFocus(n, setActive);
  const series = [
    { key: "low" as const, name: names.low, short: names.lowShort, color: PALETTE.p50, values: low, dash: undefined },
    { key: "high" as const, name: names.high, short: names.highShort, color: PALETTE.p95, values: high, dash: "6 4" },
  ];

  const lowEnd = lastValue(low);
  const highEnd = lastValue(high);
  const ends: (number | null)[] = [lowEnd, highEnd].map((v) => (v === null ? null : 100 - (Math.min(v, top) / top) * 100));
  if (ends[0] != null && ends[1] != null && Math.abs(ends[0] - ends[1]) < 9) {
    const mid = (ends[0] + ends[1]) / 2;
    ends[1] = Math.max(0, mid - 4.5);
    ends[0] = Math.min(100, mid + 4.5);
  }

  return (
    <div>
      <ul className="flex flex-wrap gap-4 text-xs text-muted" aria-label="Legend">
        {series.map((s) => (
          <li key={s.key} className="flex items-center gap-1.5">
            <svg width="14" height="4" aria-hidden="true" focusable="false">
              <line x1="0" y1="2" x2="14" y2="2" stroke={s.color} strokeWidth="2" strokeDasharray={s.dash ? "4 3" : undefined} />
            </svg>
            {s.name}
          </li>
        ))}
      </ul>
      <div className="relative mt-3 flex h-52">
        <div className="relative w-14 shrink-0 text-right text-xs tabular-nums text-muted" aria-hidden>
          {ticks.map((t) => (
            <span key={t} className="absolute right-2 translate-y-1/2 leading-none" style={{ bottom: `${(t / top) * 100}%` }}>
              {tick(t)}
            </span>
          ))}
        </div>
        <div className="relative flex-1">
          {ticks.map((t) => (
            <div key={t} className="absolute inset-x-0 h-px bg-border" style={{ bottom: `${(t / top) * 100}%` }} aria-hidden />
          ))}
          {active !== null && (
            <div className="absolute inset-y-0 w-px bg-border-strong" style={{ left: `${((active + 0.5) / n) * 100}%` }} aria-hidden />
          )}
          <svg className="absolute inset-0 h-full w-full overflow-visible" viewBox={`0 0 ${n} 100`} preserveAspectRatio="none" aria-hidden>
            {bands(low, high, top).map((polygon, i) => (
              <polygon key={i} points={polygon} fill={PALETTE.seriesSoft} fillOpacity={0.6} />
            ))}
            {series.map((s) =>
              segments(s.values, top).map((seg, i) =>
                seg.length > 1 ? (
                  <polyline
                    key={`${s.key}-${i}`}
                    points={seg.map((p) => `${p.x},${p.y}`).join(" ")}
                    fill="none"
                    stroke={s.color}
                    strokeWidth={2}
                    strokeDasharray={s.dash}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                    vectorEffect="non-scaling-stroke"
                  />
                ) : null,
              ),
            )}
          </svg>
          {series.map((s) =>
            s.values.map((v, i) => {
              const isolated = v !== null && s.values[i - 1] == null && s.values[i + 1] == null;
              if (v === null || (!isolated && active !== i)) return null;
              return (
                <span
                  key={`${s.key}-${i}`}
                  className="absolute size-2 -translate-x-1/2 translate-y-1/2 rounded-full ring-2 ring-surface"
                  style={{ left: `${((i + 0.5) / n) * 100}%`, bottom: `${(Math.min(v, top) / top) * 100}%`, background: s.color }}
                  aria-hidden
                />
              );
            }),
          )}
          <div
            role="list"
            aria-label={`${label}. Use the arrow keys to move between periods.`}
            className="absolute inset-0 flex"
            onPointerLeave={() => setActive(null)}
            onKeyDown={roving.onKeyDown}
          >
            {points.map((p, i) => (
              <div
                key={i}
                role="listitem"
                {...roving.item(i)}
                aria-label={p.description}
                className="h-full min-w-0 flex-1 cursor-default outline-none focus-visible:bg-fg/10"
                onPointerEnter={() => setActive(i)}
                onFocus={() => setActive(i)}
                onBlur={() => setActive(null)}
              />
            ))}
          </div>
          {hovered && active !== null && (
            <ChartTooltip title={hovered.longLabel} side={tooltipSide(active, n, 1)}>
              {hovered.low === null ? (
                <p className="mt-1 text-muted">{emptyTooltip}</p>
              ) : (
                series.map((s) => (
                  <p key={s.key} className="mt-1 flex items-center gap-2 whitespace-nowrap">
                    <span className="inline-block h-0.5 w-3 rounded" style={{ background: s.color }} aria-hidden />
                    <span className="font-semibold">{format(hovered[s.key])}</span>
                    <span className="text-muted">{s.short}</span>
                  </p>
                ))
              )}
            </ChartTooltip>
          )}
        </div>
        <div className="relative w-9 shrink-0 text-xs text-muted" aria-hidden>
          {series.map((s, i) =>
            ends[i] == null ? null : (
              <span key={s.key} className="absolute left-1.5 -translate-y-1/2 leading-none" style={{ top: `${ends[i]}%` }}>
                {s.short}
              </span>
            ),
          )}
        </div>
      </div>
      <div className="mr-9">
        <AxisLabels labels={points.map((p) => p.label)} offsetClass="ml-14" />
      </div>
    </div>
  );
}
