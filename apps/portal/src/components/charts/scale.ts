export function niceScale(max: number): { top: number; step: number } {
  if (max <= 0) return { top: 4, step: 1 };
  const raw = max / 3;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? 10 * pow;
  const roundedStep = Math.max(1, step);
  return { top: Math.ceil(max / roundedStep) * roundedStep, step: roundedStep };
}
export function niceSeconds(max: number): { top: number; step: number } {
  if (max <= 0) return { top: 0.1, step: 0.025 };
  const raw = max / 3;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? 10 * pow;
  return { top: Math.ceil(max / step - 1e-9) * step, step };
}

export function ticksFor(top: number, step: number): number[] {
  return Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
}
export function axisLabelIndexes(count: number): number[] {
  const last = count - 1;
  return last > 1 ? [0, Math.floor(last / 2), last] : [0, last];
}
