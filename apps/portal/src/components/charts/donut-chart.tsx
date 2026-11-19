import { categoryColor } from "./palette";

export type DonutItem = { key: string; name: string; value: number; display: string };

const percent = new Intl.NumberFormat("en", { style: "percent", maximumFractionDigits: 0 });

export function DonutChart({ items, total }: { items: readonly DonutItem[]; total: number }) {
  const radius = 15.915;
  let offset = 25;
  return (
    <div className="flex flex-wrap items-center gap-5">
      <svg viewBox="0 0 42 42" className="size-28 shrink-0" aria-hidden="true" focusable="false">
        <circle cx="21" cy="21" r={radius} fill="none" stroke="var(--surface-2)" strokeWidth="6" />
        {total > 0 &&
          items.map((item, i) => {
            const share = (item.value / total) * 100;
            const segment = (
              <circle
                key={item.key}
                cx="21"
                cy="21"
                r={radius}
                fill="none"
                stroke={categoryColor(i)}
                strokeWidth="6"
                strokeDasharray={`${share} ${100 - share}`}
                strokeDashoffset={offset}
              />
            );
            offset -= share;
            return segment;
          })}
      </svg>
      <ol className="min-w-40 flex-1 space-y-1.5 text-sm">
        {items.map((item, i) => (
          <li key={item.key} className="flex items-center gap-2">
            <span className="inline-block size-2.5 shrink-0 rounded-sm" style={{ background: categoryColor(i) }} aria-hidden />
            <span className="min-w-0 flex-1 truncate" title={item.name}>
              {item.name}
            </span>
            <span className="font-medium tabular-nums">{item.display}</span>
            <span className="w-10 text-right text-muted tabular-nums">{total > 0 ? percent.format(item.value / total) : "—"}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
