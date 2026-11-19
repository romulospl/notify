"use client";

import { LineBandChart } from "@/components/charts/line-band-chart";
import { formatLatency } from "@/lib/format";

// Latência p50 e p95 por balde do período (#37). Duas séries: legenda acima e
// rótulo direto no fim de cada linha, para a cor nunca ser a única pista.
// Cores das posições 1 e 2 da paleta categórica da skill dataviz (azul e
// laranja), validadas para os dois modos. Balde sem requisição é um buraco na
// linha, não zero. O tooltip só complementa: a tabela abaixo tem os valores.

export type LatencyPoint = { label: string; longLabel: string; p50: number | null; p95: number | null };

function tick(seconds: number): string {
  return seconds === 0 ? "0" : seconds >= 1 && Number.isInteger(seconds) ? `${seconds} s` : formatLatency(seconds);
}

export function LatencyChart({ points }: { points: LatencyPoint[] }) {
  return (
    <LineBandChart
      label="Latency per period"
      names={{ low: "p50 (median)", high: "p95", lowShort: "p50", highShort: "p95" }}
      format={formatLatency}
      tick={tick}
      emptyTooltip="No requests"
      points={points.map((p) => ({
        label: p.label,
        longLabel: p.longLabel,
        low: p.p50,
        high: p.p95,
        description: p.p50 === null ? `${p.longLabel}: no requests` : `${p.longLabel}: p50 ${formatLatency(p.p50)}, p95 ${formatLatency(p.p95)}`,
      }))}
    />
  );
}
