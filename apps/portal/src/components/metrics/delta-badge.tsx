import type { Delta } from "@/lib/format";

// Change against the previous period (#28, #29). The color says whether the
// change is good (it depends on the metric: bounce rate going up is bad) and
// always comes with an arrow and text, never color alone. Status colors from
// the dataviz skill.
export function DeltaBadge({ delta, upIsGood = true }: { delta: NonNullable<Delta>; upIsGood?: boolean }) {
  if (delta.direction === "flat") return <span className="text-muted">{delta.text}</span>;
  const good = (delta.direction === "up") === upIsGood;
  return (
    <span
      className={`inline-flex items-center rounded-full px-1.5 font-semibold tabular-nums ${
        good ? "bg-good-soft text-good" : "bg-bad-soft text-bad"
      }`}
    >
      <span aria-hidden>{delta.direction === "up" ? "▲ " : "▼ "}</span>
      <span className="sr-only">{delta.direction === "up" ? "Up " : "Down "}</span>
      {delta.text}
    </span>
  );
}
