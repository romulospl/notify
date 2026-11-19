import type { ReactNode } from "react";
import { cardClass } from "@/components/ui/card";

type ChartFrameProps = {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  table?: ReactNode;
  tableLabel?: string;
  defaultOpen?: boolean;
  className?: string;
};

export function ChartFrame({ title, subtitle, children, table, tableLabel = "Show as table", defaultOpen, className = "" }: ChartFrameProps) {
  return (
    <div className={`${cardClass} min-w-0 ${className}`}>
      <h2 className="font-semibold">{title}</h2>
      {subtitle && <p className="text-sm text-muted">{subtitle}</p>}
      <div className="mt-4">{children}</div>
      {table && (
        <details className="mt-4 text-sm" open={defaultOpen}>
          <summary className="cursor-pointer text-muted hover:text-fg">{tableLabel}</summary>
          <div className="mt-2 max-h-72 overflow-auto">{table}</div>
        </details>
      )}
    </div>
  );
}
