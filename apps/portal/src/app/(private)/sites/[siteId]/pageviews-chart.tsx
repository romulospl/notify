"use client";

import { useState } from "react";

// Colunas de visualizações por balde do período (#28). Uma série só, então sem
// legenda: o título diz o que é. Cor da série validada para os dois modos
// (skill dataviz, slot 1: #2a78d6 no claro, #3987e5 no escuro). O tooltip só
// complementa: a tabela logo abaixo do gráfico traz os mesmos valores.

export type ChartPoint = { label: string; longLabel: string; pageviews: number; visitors: number };

const full = new Intl.NumberFormat("en");
const plural = (n: number, one: string, many: string) => `${full.format(n)} ${n === 1 ? one : many}`;
const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

// Topo do eixo e passo "redondos" (1, 2 ou 5 vezes uma potência de 10).
function niceScale(max: number): { top: number; step: number } {
  if (max <= 0) return { top: 4, step: 1 };
  const raw = max / 3;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? 10 * pow);
  const roundedStep = Math.max(1, step);
  return { top: Math.ceil(max / roundedStep) * roundedStep, step: roundedStep };
}

export function PageviewsChart({ points, axisLabels }: { points: ChartPoint[]; axisLabels: number[] }) {
  const [active, setActive] = useState<number | null>(null);
  const { top, step } = niceScale(Math.max(...points.map((p) => p.pageviews)));
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
  const tickFormat = top >= 10_000 ? compact : full;
  const hovered = active === null ? null : points[active];
  const dense = points.length > 40;

  return (
    <div className="[--grid:#e4e4e7] [--series:#2a78d6] dark:[--grid:#27272a] dark:[--series:#3987e5]">
      <div className="relative flex h-52">
        {/* Eixo y: marcas redondas, alinhadas à grade. */}
        <div className="relative w-10 shrink-0 text-right text-xs tabular-nums text-zinc-500" aria-hidden>
          {ticks.map((t) => (
            <span
              key={t}
              className="absolute right-2 translate-y-1/2 leading-none"
              style={{ bottom: `${(t / top) * 100}%` }}
            >
              {tickFormat.format(t)}
            </span>
          ))}
        </div>
        <div className="relative flex-1">
          {ticks.map((t) => (
            <div
              key={t}
              className="absolute inset-x-0 h-px bg-[var(--grid)]"
              style={{ bottom: `${(t / top) * 100}%` }}
              aria-hidden
            />
          ))}
          <div
            role="list"
            aria-label="Page views per period"
            className={`absolute inset-0 flex items-end ${dense ? "gap-px" : "gap-0.5"}`}
            onPointerLeave={() => setActive(null)}
          >
            {points.map((p, i) => (
              <div
                key={i}
                role="listitem"
                tabIndex={0}
                aria-label={`${p.longLabel}: ${plural(p.pageviews, "page view", "page views")}, ${plural(p.visitors, "visitor", "visitors")}`}
                className="flex h-full min-w-0 flex-1 cursor-default items-end justify-center outline-none focus-visible:bg-zinc-500/10"
                onPointerEnter={() => setActive(i)}
                onFocus={() => setActive(i)}
                onBlur={() => setActive(null)}
              >
                {p.pageviews > 0 && (
                  <div
                    className={`w-full max-w-6 rounded-t-[4px] bg-[var(--series)] transition-opacity ${
                      active === i ? "opacity-75" : ""
                    }`}
                    style={{ height: `${(p.pageviews / top) * 100}%` }}
                  />
                )}
              </div>
            ))}
          </div>

          {hovered && (
            <div
              className="pointer-events-none absolute top-0 z-10 rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm shadow-sm dark:border-zinc-700 dark:bg-zinc-900"
              style={
                active! < points.length / 2
                  ? { left: `${(active! / points.length) * 100}%` }
                  : { right: `${((points.length - active! - 1) / points.length) * 100}%` }
              }
            >
              <p className="text-xs text-zinc-500">{hovered.longLabel}</p>
              <p className="mt-1 flex items-center gap-2 whitespace-nowrap">
                <span className="inline-block h-0.5 w-3 rounded bg-[var(--series)]" aria-hidden />
                <span className="font-semibold">{full.format(hovered.pageviews)}</span>
                <span className="text-zinc-500">{hovered.pageviews === 1 ? "page view" : "page views"}</span>
              </p>
              <p className="mt-0.5 whitespace-nowrap pl-5">
                <span className="font-semibold">{full.format(hovered.visitors)}</span>{" "}
                <span className="text-zinc-500">{hovered.visitors === 1 ? "visitor" : "visitors"}</span>
              </p>
            </div>
          )}
        </div>
      </div>
      {/* Eixo x: só alguns rótulos (início, meio e fim), para não colidirem.
          Com poucas colunas, cada rótulo fica centrado na sua; com muitas, as
          pontas encostam nas bordas para não sair do cartão. */}
      <div className="relative ml-10 mt-1 h-4 text-xs text-zinc-500" aria-hidden>
        {axisLabels.map((i) => {
          const edge = points.length > 12 && (i === 0 || i === points.length - 1);
          const left = edge ? (i === 0 ? 0 : 100) : ((i + 0.5) / points.length) * 100;
          const shift = edge ? (i === 0 ? "" : "-translate-x-full") : "-translate-x-1/2";
          return (
            <span key={i} className={`absolute whitespace-nowrap ${shift}`} style={{ left: `${left}%` }}>
              {points[i]!.label}
            </span>
          );
        })}
      </div>
    </div>
  );
}
