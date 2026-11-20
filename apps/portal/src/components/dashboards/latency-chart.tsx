"use client";

import { LineBandChart } from "@/components/charts/line-band-chart";
import { formatLatency } from "@/lib/format";

// p50 and p95 latency per bucket of the period (#37). Two series: legend above
// and a direct label at the end of each line, so color is never the only cue.
// Colors from positions 1 and 2 of the dataviz skill's categorical palette
// (blue and orange), validated for both modes. A bucket with no requests is a
// gap in the line, not zero. The tooltip only complements: the table below has
// the values.

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
