import Link from "next/link";
import { PERIODS, type PeriodKey } from "@/lib/period";

// Seletor de período dos painéis web (#28, #29): uma linha acima de tudo o que
// ele filtra. São links (GET), então funciona sem JavaScript.
export function PeriodPicker({ current, href }: { current: PeriodKey; href: (key: PeriodKey) => string }) {
  return (
    <nav aria-label="Period" className="mt-6 flex flex-wrap gap-2 text-sm">
      {(Object.keys(PERIODS) as PeriodKey[]).map((key) => (
        <Link
          key={key}
          href={href(key)}
          aria-current={key === current ? "page" : undefined}
          className={
            key === current
              ? "rounded-md bg-zinc-900 px-3 py-1.5 font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
              : "rounded-md border border-zinc-300 px-3 py-1.5 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
          }
        >
          {PERIODS[key].label}
        </Link>
      ))}
    </nav>
  );
}
