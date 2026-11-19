export function Sparkline({ values, className = "mt-2 h-7 w-full" }: { values: readonly (number | null)[]; className?: string }) {
  const present = values.filter((v): v is number => v !== null);
  if (values.length < 2 || present.length < 2) return null;
  const max = Math.max(...present);
  const min = Math.min(...present);
  const range = max - min || 1;
  const width = 120;
  const height = 28;
  const x = (i: number) => (i / (values.length - 1)) * width;
  const y = (v: number) => height - 2 - ((v - min) / range) * (height - 6);
  const segments: string[] = [];
  let current = "";
  values.forEach((v, i) => {
    if (v === null) {
      if (current) segments.push(current);
      current = "";
      return;
    }
    current += `${current ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`;
  });
  if (current) segments.push(current);
  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true" focusable="false" className={className}>
      {segments.map((d, i) => (
        <path key={i} d={d} fill="none" stroke="var(--series)" strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      ))}
    </svg>
  );
}
