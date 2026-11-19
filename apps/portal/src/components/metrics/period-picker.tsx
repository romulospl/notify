import Link from "next/link";
import { PERIODS, type PeriodKey } from "@/lib/period";

// Seletor de período dos painéis web (#28, #29): uma linha acima de tudo o que
// ele filtra. São links (GET), então funciona sem JavaScript.
export function PeriodPicker({ current, href }: { current: PeriodKey; href: (key: PeriodKey) => string }) {
  return (
    <nav aria-label="Period" className="mt-6 inline-flex flex-wrap gap-0.5 rounded-control border border-border bg-surface p-0.5 text-sm">
      {(Object.keys(PERIODS) as PeriodKey[]).map((key) => (
        <Link
          key={key}
          href={href(key)}
          aria-current={key === current ? "page" : undefined}
          className={
            key === current
              ? "rounded-[0.375rem] bg-accent px-3 py-1.5 font-medium text-accent-fg"
              : "rounded-[0.375rem] px-3 py-1.5 text-muted hover:bg-surface-2 hover:text-fg"
          }
        >
          {PERIODS[key].label}
        </Link>
      ))}
    </nav>
  );
}
