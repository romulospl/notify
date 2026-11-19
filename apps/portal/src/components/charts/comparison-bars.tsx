import { categoryColor } from "./palette";

export type ComparisonGroup = { label: string; values: { name: string; value: number; display: string }[] };

export function ComparisonBars({ groups, projects }: { groups: readonly ComparisonGroup[]; projects: readonly string[] }) {
  return (
    <div className="grid gap-4" aria-hidden="true">
      <ul className="flex flex-wrap gap-4 text-xs text-muted">
        {projects.map((name, i) => (
          <li key={name} className="flex items-center gap-1.5">
            <span className="inline-block size-2.5 rounded-sm" style={{ background: categoryColor(i) }} />
            {name}
          </li>
        ))}
      </ul>
      {groups.map((group) => {
        const max = Math.max(1, ...group.values.map((v) => v.value));
        return (
          <div key={group.label} className="grid gap-1.5">
            <p className="text-sm font-medium">{group.label}</p>
            {group.values.map((v, i) => (
              <div key={v.name} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
                <div className="h-2.5 rounded-r-[3px]" style={{ width: `${Math.max(1, (v.value / max) * 100)}%`, background: categoryColor(i) }} />
                <span className="text-xs tabular-nums">{v.display}</span>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
