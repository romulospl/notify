export const PALETTE = {
  series: "var(--series)",
  seriesSoft: "var(--series-soft)",
  ok: "var(--series)",
  clientError: "var(--warn-fill)",
  serverError: "var(--bad-fill)",
  p50: "var(--c1)",
  p95: "var(--c3)",
  categories: ["var(--c1)", "var(--c2)", "var(--c3)", "var(--c4)", "var(--c5)"],
} as const;

export function categoryColor(index: number): string {
  return PALETTE.categories[index % PALETTE.categories.length] ?? PALETTE.series;
}
