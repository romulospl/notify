import type { ReactNode } from "react";
import { cardClass } from "@/components/ui/card";

export type RankedRow = {
  key: string;
  name: string;
  value: number;
  display: string;
  detail?: string;
};

type RankedListProps = {
  title: string;
  unit: string;
  rows: readonly RankedRow[];
  empty?: string;
  footer?: ReactNode;
};

export function RankedList({ title, unit, rows, empty = "No data in this period.", footer }: RankedListProps) {
  const max = Math.max(1, ...rows.map((row) => row.value));
  return (
    <div className={cardClass}>
      <div className="flex items-baseline justify-between">
        <h2 className="font-semibold">{title}</h2>
        <span className="text-xs text-muted">{unit}</span>
      </div>
      {rows.length === 0 ? (
        <p className="mt-3 text-sm text-muted">{empty}</p>
      ) : (
        <ol className="mt-3 space-y-2 text-sm">
          {rows.map((row) => (
            <li key={row.key}>
              <div className="flex items-baseline justify-between gap-3">
                <span className="truncate" title={row.name}>
                  {row.name}
                </span>
                <span className="whitespace-nowrap font-medium tabular-nums">
                  {row.display}
                  {row.detail && <span className="font-normal text-muted"> · {row.detail}</span>}
                </span>
              </div>
              <div className="mt-1 h-1.5 rounded-r-[4px] bg-series" style={{ width: `${(row.value / max) * 100}%` }} />
            </li>
          ))}
        </ol>
      )}
      {footer && <p className="mt-3 text-sm text-muted">{footer}</p>}
    </div>
  );
}
