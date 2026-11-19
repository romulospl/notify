import { Icon, type IconName } from "./icons";

export type ChipTone = "good" | "warn" | "bad" | "neutral" | "info";

const TONES: Record<ChipTone, { className: string; icon: IconName }> = {
  good: { className: "bg-good-soft text-good", icon: "check" },
  warn: { className: "bg-warn-soft text-warn", icon: "clock" },
  bad: { className: "bg-bad-soft text-bad", icon: "x" },
  neutral: { className: "bg-surface-2 text-muted", icon: "minus" },
  info: { className: "bg-info-soft text-info", icon: "info" },
};

export function StatusChip({ tone, children }: { tone: ChipTone; children: React.ReactNode }) {
  const { className, icon } = TONES[tone];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold whitespace-nowrap ${className}`}>
      <Icon name={icon} className="size-3" />
      {children}
    </span>
  );
}
