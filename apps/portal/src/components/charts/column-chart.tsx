"use client";

import { useState } from "react";
import { AxisLabels } from "./axis-labels";
import { ChartTooltip, tooltipSide } from "./chart-tooltip";
import { niceScale, ticksFor } from "./scale";
import { useRovingFocus } from "./use-roving-focus";

export type ColumnPoint = {
  label: string;
  longLabel: string;
  value: number;
  description: string;
  tooltip: { value: string; unit: string }[];
};

const full = new Intl.NumberFormat("en");
const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

const HATCH = "repeating-linear-gradient(135deg, var(--series) 0 4px, color-mix(in oklab, var(--series) 40%, transparent) 4px 7px)";

export function ColumnChart({ points, label, currentIncomplete = false }: { points: ColumnPoint[]; label: string; currentIncomplete?: boolean }) {
  const [active, setActive] = useState<number | null>(null);
  const { top, step } = niceScale(Math.max(...points.map((p) => p.value)));
  const ticks = ticksFor(top, step);
  const tickFormat = top >= 10_000 ? compact : full;
  const hovered = active === null ? null : points[active];
  const dense = points.length > 40;
  const roving = useRovingFocus(points.length, setActive);
  const last = points.length - 1;

  return (
    <div>
      <div className="relative flex h-52">
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
          <div
            role="list"
            aria-label={`${label}. Use the arrow keys to move between periods.`}
            className={`absolute inset-0 flex items-end ${dense ? "gap-px" : "gap-0.5"}`}
            onPointerLeave={() => setActive(null)}
            onKeyDown={roving.onKeyDown}
          >
            {points.map((p, i) => (
              <div
                key={i}
                role="listitem"
                {...roving.item(i)}
                aria-label={p.description}
                className="flex h-full min-w-0 flex-1 cursor-default items-end justify-center outline-none focus-visible:bg-fg/10"
                onPointerEnter={() => setActive(i)}
                onFocus={() => setActive(i)}
                onBlur={() => setActive(null)}
              >
                {p.value > 0 && (
                  <div
                    className={`w-full max-w-6 rounded-t-[4px] bg-series transition-opacity motion-reduce:transition-none ${active === i ? "opacity-75" : ""}`}
                    style={{ height: `${(p.value / top) * 100}%`, ...(currentIncomplete && i === last ? { background: HATCH } : {}) }}
                  />
                )}
              </div>
            ))}
          </div>

          {hovered && active !== null && (
            <ChartTooltip title={hovered.longLabel} side={tooltipSide(active, points.length)}>
              {hovered.tooltip.map((line, i) => (
                <p key={i} className={`flex items-center gap-2 whitespace-nowrap ${i === 0 ? "mt-1" : "mt-0.5 pl-5"}`}>
                  {i === 0 && <span className="inline-block h-0.5 w-3 rounded bg-series" aria-hidden />}
                  <span className="font-semibold">{line.value}</span>
                  <span className="text-muted">{line.unit}</span>
                </p>
              ))}
              {currentIncomplete && active === last && <p className="mt-1 text-xs text-muted">In progress</p>}
            </ChartTooltip>
          )}
        </div>
      </div>
      <AxisLabels labels={points.map((p) => p.label)} />
    </div>
  );
}
