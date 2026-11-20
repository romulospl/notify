import { ColumnChart } from "@/components/charts/column-chart";

// Pageviews per bucket of the period (#28), with the visitors in the tooltip.

export type ChartPoint = { label: string; longLabel: string; pageviews: number; visitors: number };

const full = new Intl.NumberFormat("en");
const plural = (n: number, one: string, many: string) => `${full.format(n)} ${n === 1 ? one : many}`;

export function PageviewsChart({ points }: { points: ChartPoint[] }) {
  return (
    <ColumnChart
      label="Page views per period"
      currentIncomplete
      points={points.map((p) => ({
        label: p.label,
        longLabel: p.longLabel,
        value: p.pageviews,
        description: `${p.longLabel}: ${plural(p.pageviews, "page view", "page views")}, ${plural(p.visitors, "visitor", "visitors")}`,
        tooltip: [
          { value: full.format(p.pageviews), unit: p.pageviews === 1 ? "page view" : "page views" },
          { value: full.format(p.visitors), unit: p.visitors === 1 ? "visitor" : "visitors" },
        ],
      }))}
    />
  );
}
