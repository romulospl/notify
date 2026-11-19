import type { ReactNode } from "react";
import { cardClass } from "@/components/ui/card";

type MetricCardProps = { label: string; value: string; chart?: ReactNode; children?: ReactNode };

export function MetricCard({ label, value, chart, children }: MetricCardProps) {
  return (
    <div className={cardClass}>
      <p className="text-[0.8125rem] font-medium text-muted">{label}</p>
      <p className="mt-1 text-[1.75rem] leading-tight font-semibold tracking-tight tabular-nums">{value}</p>
      {chart}
      {children && <div className="mt-1.5 text-xs">{children}</div>}
    </div>
  );
}
