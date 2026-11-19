import type { ReactNode } from "react";

export function ChartTooltip({ title, side, children }: { title: string; side: { left?: string; right?: string }; children: ReactNode }) {
  return (
    <div
      className="pointer-events-none absolute top-0 z-10 rounded-control border border-border bg-surface px-3 py-2 text-sm shadow-lg"
      style={side}
    >
      <p className="text-xs text-muted">{title}</p>
      {children}
    </div>
  );
}

export function tooltipSide(active: number, count: number, offset = 0): { left?: string; right?: string } {
  return active < count / 2
    ? { left: `${((active + offset) / count) * 100}%` }
    : { right: `${((count - active - 1 + offset) / count) * 100}%` };
}
