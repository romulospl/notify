"use client";

import { StackedAreaChart } from "@/components/charts/stacked-area-chart";

export type StatusPoint = { label: string; longLabel: string; ok: number; clientErrors: number; serverErrors: number };

const full = new Intl.NumberFormat("en");

export function StatusChart({ points, colors }: { points: StatusPoint[]; colors: { ok: string; clientErrors: string; serverErrors: string } }) {
  return (
    <StackedAreaChart
      label="Responses by status class per period"
      series={[
        { name: "OK", color: colors.ok },
        { name: "4xx", color: colors.clientErrors },
        { name: "5xx", color: colors.serverErrors },
      ]}
      points={points.map((p) => ({
        label: p.label,
        longLabel: p.longLabel,
        parts: [p.ok, p.clientErrors, p.serverErrors],
        description: `${p.longLabel}: ${full.format(p.ok)} OK, ${full.format(p.clientErrors)} 4xx, ${full.format(p.serverErrors)} 5xx`,
      }))}
    />
  );
}
