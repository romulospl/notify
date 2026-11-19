import { axisLabelIndexes } from "./scale";
export function AxisLabels({ labels, offsetClass = "ml-10" }: { labels: string[]; offsetClass?: string }) {
  return (
    <div className={`relative ${offsetClass} mt-1 h-4 text-xs text-muted`} aria-hidden>
      {axisLabelIndexes(labels.length).map((i) => {
        const edge = labels.length > 12 && (i === 0 || i === labels.length - 1);
        const left = edge ? (i === 0 ? 0 : 100) : ((i + 0.5) / labels.length) * 100;
        const shift = edge ? (i === 0 ? "" : "-translate-x-full") : "-translate-x-1/2";
        return (
          <span key={i} className={`absolute whitespace-nowrap ${shift}`} style={{ left: `${left}%` }}>
            {labels[i]}
          </span>
        );
      })}
    </div>
  );
}
