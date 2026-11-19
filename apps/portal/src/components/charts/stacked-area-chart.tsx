"use client";

import { useState } from "react";
import { AxisLabels } from "./axis-labels";
import { ChartTooltip, tooltipSide } from "./chart-tooltip";
import { niceScale, ticksFor } from "./scale";
import { useRovingFocus } from "./use-roving-focus";

export type StackedSeries = { name: string; color: string };
export type StackedPoint = { label: string; longLabel: string; parts: number[]; description: string };

const full = new Intl.NumberFormat("en");
const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

export function StackedAreaChart({ points, series, label }: { points: StackedPoint[]; series: readonly StackedSeries[]; label: string }) {
  const [active, setActive] = useState<number | null>(null);
  const n = points.length;
  const totals = points.map((p) => p.parts.reduce((sum, v) => sum + v, 0));
  const { top, step } = niceScale(Math.max(0, ...totals));
  const ticks = ticksFor(top, step);
  const tickFormat = top >= 10_000 ? compact : full;
  const roving = useRovingFocus(n, setActive);
  const hovered = active === null ? null : points[active];
  const y = (v: number) => 100 - (v / top) * 100;

  const layers = series.map((_, s) => {
    const upper = points.map((p, i) => ({ x: i + 0.5, y: y(p.parts.slice(0, s + 1).reduce((sum, v) => sum + v, 0)) }));
    const lower = points.map((p, i) => ({ x: i + 0.5, y: y(p.parts.slice(0, s).reduce((sum, v) => sum + v, 0)) }));
    return [...upper, ...lower.reverse()].map((c) => `${c.x},${c.y}`).join(" ");
  });

  return (
    <div>
      <ul className="flex flex-wrap gap-4 text-xs text-muted" aria-label="Legend">
        {series.map((s) => (
          <li key={s.name} className="flex items-center gap-1.5">
            <span className="inline-block size-2.5 rounded-sm" style={{ background: s.color }} aria-hidden />
            {s.name}
          </li>
        ))}
      </ul>
      <div className="relative mt-3 flex h-52">
        <div className="relative w-10 shrink-0 text-right text-xs tabular-nums text-muted" aria-hidden>
          {ticks.map((t) => (
            <span key={t} className="absolute right-2 translate-y-1/2 leading-none" style={{ bottom: `${(t / top) * 100}%` }}>
              {tickFormat.format(t)}
            </span>
          ))}
        </div>
        <div className="relative flex-1">
          {ticks.map((t) => (
            <div key={t} className="absolute inset-x-0 h-px bg-border" style={{ bottom: `${(t / top) * 100}%` }} aria-hidden />
          ))}
          {n > 1 && (
            <svg className="absolute inset-0 h-full w-full" viewBox={`0 0 ${n} 100`} preserveAspectRatio="none" aria-hidden>
              {layers.map((polygon, s) => (
                <polygon key={series[s]?.name} points={polygon} fill={series[s]?.color} fillOpacity={0.85} />
              ))}
            </svg>
          )}
          {active !== null && (
            <div className="absolute inset-y-0 w-px bg-border-strong" style={{ left: `${((active + 0.5) / n) * 100}%` }} aria-hidden />
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
              {series.map((s, i) => (
                <p key={s.name} className="mt-1 flex items-center gap-2 whitespace-nowrap">
                  <span className="inline-block size-2.5 rounded-sm" style={{ background: s.color }} aria-hidden />
                  <span className="font-semibold">{full.format(hovered.parts[i] ?? 0)}</span>
                  <span className="text-muted">{s.name}</span>
                </p>
              ))}
            </ChartTooltip>
          )}
        </div>
      </div>
      <AxisLabels labels={points.map((p) => p.label)} />
    </div>
  );
}
