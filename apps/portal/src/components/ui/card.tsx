import type { ReactNode } from "react";

export const cardClass = "rounded-card border border-border bg-surface p-4 shadow-card";

export function Card({ className = "", children }: { className?: string; children: ReactNode }) {
  return <div className={`${cardClass} ${className}`}>{children}</div>;
}
